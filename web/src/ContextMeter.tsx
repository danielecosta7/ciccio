import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { rise } from './motion';
import type { ContextInfo } from '../../shared/types';

const k = (n: number) => `${Math.round(n / 1000)}k`;

function colorFor(pct: number, warn: number) {
  return pct >= 95 ? '#FF6A55' : pct >= warn ? '#FFB224' : pct >= 50 ? '#A6FF00' : 'oklch(0.72 0 0)';
}

/**
 * Contesto della sessione: quanto è piena, e le due strade di Claude Code quando si riempie —
 * comprimere (Claude riassume e continua) o ripartire con una sessione nuova (i messaggi restano).
 */
export function ContextMeter(props: { context: ContextInfo | null; warn: number; onCompact: () => void; onNewSession: () => void; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const c = props.context;
  const pct = c?.pct ?? 0;
  const color = colorFor(pct, props.warn);
  const filled = Math.min(8, Math.ceil(pct / 12.5));
  return (
    <span ref={box} className="relative inline-flex">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        title={c ? `Contesto: ${pct}% (${k(c.used)} di ${k(c.max)} token)` : 'Contesto: si misura dopo il primo giro'}
        className="cc-press inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-line px-2 font-mono text-[11.5px] text-muted hover:text-text">
        <span className="inline-flex gap-[2px]" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => <span key={i} style={{ width: 3, height: 9, background: i < filled ? color : 'oklch(0.3 0 0)' }} />)}
        </span>
        <span style={{ color: c ? color : undefined }}>{c ? `${pct}%` : '–'}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.span key="ctx" {...rise}
            className={`absolute top-full z-50 mt-2 flex w-[270px] flex-col gap-2.5 rounded-[12px] border border-line-hi bg-panel p-3.5 text-left shadow-[0_6px_8px_rgb(0_0_0/.45)] ${props.align === 'left' ? 'left-0' : 'right-0'}`}>
            <span className="text-[13px] font-semibold">Contesto della sessione</span>
            <span className="text-[12.5px] leading-snug text-muted">
              {c ? `${pct}% usato: ${k(c.used)} di ${k(c.max)} token.` : 'Si misura dopo il primo giro.'} Quando è pieno puoi comprimere (Claude riassume e continua) o ripartire con una sessione nuova: i messaggi restano comunque qui.
            </span>
            <span className="flex gap-1.5">
              <button type="button" onClick={() => { setOpen(false); props.onCompact(); }} disabled={!c}
                className="cc-press min-h-9 flex-1 rounded-[8px] bg-acid px-2 text-[13px] font-semibold text-ink disabled:opacity-40">Comprimi</button>
              <button type="button" onClick={() => { setOpen(false); props.onNewSession(); }}
                className="cc-press min-h-9 flex-1 rounded-[8px] border border-line-hi px-2 text-[13px]">Nuova sessione</button>
            </span>
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/** Contesto per esteso, dentro un foglio del telefono: barre, token e le due strade, sempre visibili. */
export function ContextPanel(props: { context: ContextInfo | null; warn: number; onCompact: () => void; onNewSession: () => void }) {
  const c = props.context;
  const pct = c?.pct ?? 0;
  const color = colorFor(pct, props.warn);
  const filled = Math.min(10, Math.ceil(pct / 10));
  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-line bg-panel p-3.5">
      <div className="flex items-center gap-3">
        <span className="text-[14px] font-medium">Contesto</span>
        <span className="inline-flex gap-[3px]" aria-hidden="true">
          {Array.from({ length: 10 }, (_, i) => <span key={i} style={{ width: 4, height: 12, background: i < filled ? color : 'oklch(0.3 0 0)' }} />)}
        </span>
        <span className="font-mono text-[12.5px]" style={{ color: c ? color : undefined }}>{c ? `${pct}%` : '–'}</span>
        <span className="ml-auto font-mono text-[11.5px] text-muted">{c ? `${k(c.used)} di ${k(c.max)}` : 'dopo il primo giro'}</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" onClick={props.onCompact} disabled={!c} className="cc-press min-h-11 rounded-[10px] border border-line-hi text-[13.5px] font-medium disabled:opacity-40">Comprimi</button>
        <button type="button" onClick={props.onNewSession} className="cc-press min-h-11 rounded-[10px] border border-line-hi text-[13.5px] font-medium">Nuova sessione</button>
      </div>
    </div>
  );
}

/**
 * Avviso sopra il campo di testo quando il contesto supera la soglia delle Impostazioni.
 * Premuto «Comprimi» o «Nuova sessione» sparisce subito (il lavoro lo dice già la chat); torna solo se, finito
 * il giro, il contesto è ancora oltre la soglia (la compressione non è riuscita). `running`: il giro in corso.
 */
export function ContextWarning(props: { context: ContextInfo | null; warn: number; running: boolean; onCompact: () => void; onNewSession: () => void }) {
  const c = props.context;
  const [asked, setAsked] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (!asked) return undefined;
    if (props.running) { started.current = true; return undefined; }
    if (!started.current) return undefined;
    // Giro finito: il contesto nuovo può arrivare un attimo dopo, quindi si aspetta prima di rimostrarlo.
    started.current = false;
    const t = setTimeout(() => setAsked(false), 2000);
    return () => clearTimeout(t);
  }, [asked, props.running]);
  // Sceso sotto la soglia (compressione o sessione nuova): la prossima volta l'avviso torna normalmente.
  useEffect(() => { if (asked && c && c.pct < props.warn) setAsked(false); }, [asked, c, props.warn]);
  const act = (f: () => void) => () => { started.current = props.running; setAsked(true); f(); };
  return (
    <AnimatePresence>
      {c && c.pct >= props.warn && !asked && (
        <motion.div key="warn" {...rise} className="mx-auto mb-2 flex w-full max-w-[880px] flex-wrap items-center gap-2 px-4 sm:px-6">
          <div className="flex w-full flex-wrap items-center gap-2 rounded-[10px] border border-wait/45 bg-wait/[.06] px-3 py-2">
            <span className="min-w-0 flex-1 text-[13px] leading-snug">
              <span className="font-semibold text-wait">Contesto al {c.pct}%.</span> <span className="text-soft">Comprimi per continuare questa sessione, o riparti da una nuova.</span>
            </span>
            <button type="button" onClick={act(props.onCompact)} className="cc-press min-h-9 rounded-[8px] bg-acid px-3 text-[13px] font-semibold text-ink">Comprimi</button>
            <button type="button" onClick={act(props.onNewSession)} className="cc-press min-h-9 rounded-[8px] border border-line-hi px-3 text-[13px]">Nuova sessione</button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
