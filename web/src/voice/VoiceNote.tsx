import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { MicIcon, Orb, SendIcon } from '../ui';
import { pop, quick } from '../motion';
import { Mic } from './mic';
import { BrowserEar } from './browserStt';
import { transcribe } from './wav';
import { getVoicePrefs } from './hooks';

/** Sotto questa durata è un tocco per sbaglio: non parte niente. */
const MIN_MS = 700;
/** Tetto di un vocale: poi si invia da solo (e resta sotto il limite del servizio voce). */
const MAX_MS = 3 * 60_000;
/** Quanto trascinare a sinistra per annullare, in alto per bloccare la registrazione. */
const CANCEL_PX = 90;
const LOCK_PX = 70;

type Phase = 'idle' | 'arming' | 'recording' | 'locked' | 'sending';
interface Notice { text: string; tone: 'info' | 'error' }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/**
 * Vocale come su WhatsApp: tieni premuto per registrare, rilasci e parte. Trascini a sinistra per annullare,
 * in alto per bloccarlo e parlare senza tenere premuto. Il testo trascritto (servizio scelto nelle
 * Impostazioni › Voce) va nella chat come messaggio; se la trascrizione fallisce o è vuota non parte niente.
 */
function useVoiceNote(send: (text: string) => Promise<void>, keep?: (text: string) => void) {
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [ms, setMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [notice, setNotice] = useState<Notice | null>(null);
  const phaseRef = useRef<Phase>('idle');
  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p); };
  const mic = useRef<Mic | null>(null);
  const ear = useRef<BrowserEar | null>(null);
  /** Con la trascrizione del browser il testo arriva mentre parli: frasi finite e pezzo in corso. */
  const heard = useRef({ finals: [] as string[], interim: '' });
  const origin = useRef({ x: 0, y: 0 });
  /** Il dito (o il mouse) che tiene premuto: gli altri puntatori non spostano niente. */
  const pointer = useRef<number | null>(null);
  const pressAt = useRef(0);
  const readyAt = useRef(0);
  const levelAt = useRef(0);
  /** Rilasciato mentre il microfono si apriva (magari chiedendo il permesso). */
  const released = useRef(false);
  /** A registrazione bloccata, il tasto diventa «invia»: parte al rilascio del nuovo tocco. */
  const sendOnUp = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sendRef = useRef(send);
  sendRef.current = send;
  const keepRef = useRef(keep);
  keepRef.current = keep;

  const tell = useCallback((text: string, tone: Notice['tone'] = 'info') => {
    clearTimeout(noticeTimer.current);
    setNotice({ text, tone });
    noticeTimer.current = setTimeout(() => setNotice(null), tone === 'error' ? 7000 : 3500);
  }, []);

  const close = useCallback(() => {
    mic.current?.stop(); mic.current = null;
    ear.current?.stop(); ear.current = null;
    setLevel(0);
    setDrag({ x: 0, y: 0 });
  }, []);

  const cancel = useCallback((why?: string) => {
    close();
    setPhase('idle');
    setMs(0);
    if (why) tell(why);
  }, [close, tell]);

  const finish = useCallback(async () => {
    const p = phaseRef.current;
    if (p !== 'recording' && p !== 'locked') return;
    if (Date.now() - readyAt.current < MIN_MS) { cancel('Tieni premuto il microfono per registrare, rilascia per inviare.'); return; }
    const pcm = mic.current ? mic.current.recorded() : null;
    const said = [...heard.current.finals, heard.current.interim].join(' ').replace(/\s+/g, ' ').trim();
    close();
    setPhase('sending');
    try {
      let text: string;
      try { text = pcm ? await transcribe(pcm) : said; } catch (e) { tell(`Trascrizione non riuscita (${message(e)}): non ho inviato niente.`, 'error'); return; }
      if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 2) { tell('Nel vocale non ho sentito parole: non ho inviato niente.', 'error'); return; }
      try { await sendRef.current(text); } catch (e) { keepRef.current?.(text); tell(`Invio non riuscito (${message(e)}): il testo è rimasto nel campo.`, 'error'); }
    } finally {
      setPhase('idle');
      setMs(0);
    }
  }, [cancel, close, tell]);

  const begin = useCallback(async () => {
    released.current = false;
    sendOnUp.current = false;
    heard.current = { finals: [], interim: '' };
    pressAt.current = Date.now();
    setMs(0);
    setDrag({ x: 0, y: 0 });
    clearTimeout(noticeTimer.current);
    setNotice(null);
    setPhase('arming');
    let m: Mic | null = null;
    try {
      if (getVoicePrefs().stt === 'browser') {
        ear.current = new BrowserEar({
          onInterim: (t) => { heard.current.interim = t; setLevel(0.35 + Math.random() * 0.45); },
          onFinal: (t) => { heard.current.finals.push(t); heard.current.interim = ''; },
          onError: (msg) => cancel(msg),
        });
        ear.current.start();
      } else {
        // Il microfono si apre nel tocco stesso (iPhone) e tiene tutto l'audio, pause comprese.
        m = new Mic({ onLevel: (l) => { const now = Date.now(); if (now - levelAt.current > 66) { levelAt.current = now; setLevel(l); } } });
        m.sensitivity = getVoicePrefs().sensitivity ?? 'media';
        m.record();
        await m.start();
      }
    } catch (e) {
      m?.stop();
      ear.current?.stop(); ear.current = null;
      if (phaseRef.current !== 'arming') return;
      setPhase('idle');
      const msg = message(e);
      tell(/denied|NotAllowed|Permission/i.test(msg) ? 'Serve il permesso per il microfono: concedilo dal lucchetto accanto all\'indirizzo, poi riprova.' : `Microfono non disponibile: ${msg}`, 'error');
      return;
    }
    // Annullato o rilasciato mentre il microfono si apriva: niente registrazione.
    if (phaseRef.current !== 'arming' || released.current) {
      m?.stop();
      ear.current?.stop(); ear.current = null;
      if (phaseRef.current !== 'arming') return;
      setPhase('idle');
      setLevel(0);
      tell(Date.now() - pressAt.current > 1200 ? 'Microfono pronto: tieni premuto per registrare.' : 'Tieni premuto il microfono per registrare, rilascia per inviare.');
      return;
    }
    mic.current = m;
    readyAt.current = Date.now();
    setPhase('recording');
  }, [cancel, tell]);

  // Contatore dei secondi; al tetto il vocale parte da solo.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'locked') return;
    const t = setInterval(() => {
      const d = Date.now() - readyAt.current;
      setMs(d);
      if (d >= MAX_MS) void finish();
    }, 200);
    return () => clearInterval(t);
  }, [phase, finish]);

  // Esc annulla, ovunque sia il fuoco.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'locked') return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') cancel('Vocale annullato.'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, cancel]);

  useEffect(() => () => { phaseRef.current = 'idle'; clearTimeout(noticeTimer.current); mic.current?.stop(); ear.current?.stop(); }, []);

  const handlers = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (phaseRef.current === 'locked') { sendOnUp.current = true; return; }
      if (phaseRef.current !== 'idle') return;
      // Il tasto tiene il puntatore anche se il dito scivola via: rilascio e trascinamento arrivano sempre qui.
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* puntatore già rilasciato */ }
      pointer.current = e.pointerId;
      origin.current = { x: e.clientX, y: e.clientY };
      void begin();
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      const p = phaseRef.current;
      if ((p !== 'recording' && p !== 'arming') || e.pointerId !== pointer.current) return;
      const x = Math.min(0, e.clientX - origin.current.x);
      const y = Math.min(0, e.clientY - origin.current.y);
      if (p === 'recording' && x < -CANCEL_PX) { cancel('Vocale annullato.'); return; }
      if (p === 'recording' && y < -LOCK_PX) { setPhase('locked'); setDrag({ x: 0, y: 0 }); return; }
      setDrag({ x, y });
    },
    onPointerUp: () => {
      pointer.current = null;
      const p = phaseRef.current;
      if (p === 'arming') released.current = true;
      else if (p === 'recording') void finish();
      else if (p === 'locked' && sendOnUp.current) { sendOnUp.current = false; void finish(); }
    },
    onPointerCancel: () => {
      pointer.current = null;
      const p = phaseRef.current;
      if (p === 'arming') setPhase('idle');
      else if (p === 'recording') cancel('Vocale annullato.');
    },
    // Da tastiera: Spazio o Invio tenuti premuti come il dito; a registrazione bloccata Invio manda.
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      if (e.repeat) return;
      if (phaseRef.current === 'idle') void begin();
      else if (phaseRef.current === 'locked') void finish();
    },
    onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      if (phaseRef.current === 'arming') released.current = true;
      else if (phaseRef.current === 'recording') void finish();
    },
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  };

  return { phase, ms, level, drag, notice, cancel, handlers };
}

export const voiceNoteSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** Barrette che seguono la voce mentre registri. */
function Level({ level }: { level: number }) {
  return (
    <span className="flex h-4 flex-none items-center gap-[3px]" aria-hidden="true">
      {[0.55, 0.9, 1, 0.75, 0.5].map((k, i) => (
        <i key={i} className="block w-[3px] bg-acid transition-[height] duration-75" style={{ height: `${Math.max(3, Math.round(level * k * 16))}px` }} />
      ))}
    </span>
  );
}

/**
 * Tasto del microfono per i vocali, con la striscia di registrazione che copre il campo di testo
 * (il genitore posizionato più vicino) e gli avvisi sopra.
 */
export function VoiceNote(props: {
  onSend: (text: string) => Promise<void>;
  /** Invio fallito: il testo trascritto non va perso. */
  onKeep?: (text: string) => void;
  /** Classi del tasto quando è fermo (dimensioni, forma, colori). */
  className: string;
  /** Classi della striscia che copre il campo mentre registri (forma e sfondo). */
  stripClassName: string;
  iconSize?: number;
}) {
  const v = useVoiceNote(props.onSend, props.onKeep);
  const live = v.phase === 'arming' || v.phase === 'recording' || v.phase === 'locked';
  const label = v.phase === 'locked' ? 'Invia il vocale' : v.phase === 'recording' ? 'Rilascia per inviare il vocale' : 'Tieni premuto per registrare un vocale';
  return (
    <>
      <AnimatePresence>
        {v.phase !== 'idle' && (
          <motion.div key="strip" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: quick }} exit={{ opacity: 0, transition: quick }}
            role="status" aria-live="polite"
            className={`absolute inset-0 z-10 flex select-none items-center gap-3 overflow-hidden px-3 ${props.stripClassName}`}>
            {v.phase === 'sending' ? (
              <>
                <Orb state="solving" size={20} label="Trascrivo" />
                <span className="text-[13.5px] text-soft">Trascrivo il vocale…</span>
              </>
            ) : (
              <>
                {v.phase === 'locked' && (
                  <button type="button" onClick={() => v.cancel('Vocale annullato.')} aria-label="Annulla il vocale" title="Annulla"
                    className="cc-press flex h-9 w-9 flex-none items-center justify-center rounded-[8px] text-muted hover:text-block">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
                  </button>
                )}
                <span className={`h-2.5 w-2.5 flex-none bg-block ${v.phase === 'arming' ? 'opacity-40' : 'cc-rec'}`} aria-hidden="true" />
                <span className="flex-none font-mono text-[14px] tabular-nums text-text" aria-label={`Registrazione: ${clock(v.ms)}`}>{clock(v.ms)}</span>
                <Level level={v.level} />
                <span className="min-w-0 flex-1 truncate text-center text-[12.5px] text-muted"
                  style={v.phase === 'recording' ? { transform: `translateX(${v.drag.x / 2}px)`, opacity: Math.max(0.15, 1 + v.drag.x / CANCEL_PX) } : undefined}>
                  {v.phase === 'arming' ? 'Apro il microfono…' : v.phase === 'locked' ? 'Parla pure, poi tocca invia' : '‹ Scorri per annullare'}
                </span>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {v.notice && v.phase === 'idle' && (
          <motion.div key="notice" {...pop} role={v.notice.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-none absolute right-0 bottom-full left-0 z-20 mb-2 flex justify-center`}>
            <span className={`cc-wrap rounded-[10px] border bg-panel px-3 py-2 text-[13px] leading-snug shadow-[0_6px_8px_rgb(0_0_0/.45)] ${v.notice.tone === 'error' ? 'border-block/50 text-block' : 'border-line-hi text-soft'}`}>{v.notice.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
      <span className="relative z-20 flex flex-none">
        <AnimatePresence>
          {v.phase === 'recording' && (
            // Lucchetto sopra il tasto: trascinando in alto la registrazione resta accesa senza tenere premuto.
            <motion.span key="lock" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: Math.max(-LOCK_PX / 2, v.drag.y / 2), transition: quick }} exit={{ opacity: 0, transition: quick }}
              aria-hidden="true"
              className="pointer-events-none absolute bottom-full left-1/2 mb-4 -ml-[15px] flex w-[30px] flex-col items-center gap-1 rounded-full border border-line-hi bg-panel py-2 text-muted">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="1" /><path d="M8 11V7a4 4 0 018 0v4" /></svg>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>
            </motion.span>
          )}
        </AnimatePresence>
        <motion.button type="button" {...v.handlers} aria-label={label} title={v.phase === 'idle' ? 'Tieni premuto per un vocale' : undefined}
          animate={{ scale: v.phase === 'recording' ? 1.25 : 1, transition: quick }}
          disabled={v.phase === 'sending'}
          className={`touch-none select-none [-webkit-touch-callout:none] disabled:opacity-60 ${props.className} ${live ? '!bg-acid !text-ink' : ''}`}>
          {v.phase === 'locked' ? <SendIcon size={props.iconSize} /> : <MicIcon size={props.iconSize} />}
        </motion.button>
      </span>
    </>
  );
}
