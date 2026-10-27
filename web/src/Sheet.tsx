import { useEffect, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion, useDragControls, type PanInfo } from 'motion/react';
import { sheetIn, sheetOut } from './motion';

/**
 * Foglio dal basso del telefono: maniglia, velo, safe area. Si chiude trascinando giù dalla maniglia (o dall'intestazione),
 * toccando il velo o con Esc. `size`: «auto» alto quanto il contenuto (al massimo quasi tutto lo schermo), «full» quasi
 * tutto lo schermo. Il contenuto scorre da sé: il trascinamento parte solo dalla parte alta, così non litiga con lo scorrimento.
 */
export function Sheet(props: {
  open: boolean;
  onClose: () => void;
  label: string;
  title?: ReactNode;
  /** Riga sotto il titolo (progetto, branch…). */
  sub?: ReactNode;
  /** Comandi a destra del titolo. */
  actions?: ReactNode;
  size?: 'auto' | 'full';
  children: ReactNode;
  /** Classi del riquadro che scorre. */
  bodyClassName?: string;
}) {
  const drag = useDragControls();
  const box = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!props.open) return undefined;
    back.current = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => box.current?.focus({ preventScroll: true }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); props.onClose(); }
      // Il Tab resta dentro il foglio.
      if (e.key === 'Tab' && box.current) {
        const items = [...box.current.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); back.current?.focus?.({ preventScroll: true }); };
  }, [props.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 110 || info.velocity.y > 600) props.onClose();
  };

  return (
    <AnimatePresence>
      {props.open && (
        <motion.div key="sheet" className="cc-viewport z-[58]" initial={{ opacity: 1 }} exit={{ opacity: 1 }}>
          <motion.div aria-hidden="true" onClick={props.onClose} className="absolute inset-0 bg-black/60"
            initial={{ opacity: 0 }} animate={{ opacity: 1, transition: sheetIn }} exit={{ opacity: 0, transition: sheetOut }} />
          <motion.div ref={box} role="dialog" aria-modal="true" aria-label={props.label} tabIndex={-1}
            drag="y" dragControls={drag} dragListener={false} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0.04, bottom: 0.9 }}
            onDragEnd={onDragEnd}
            initial={{ y: '100%' }} animate={{ y: 0, transition: sheetIn }} exit={{ y: '100%', transition: sheetOut }}
            style={{ maxHeight: 'calc(100% - var(--cc-top) - 12px)' }}
            className={`absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-[18px] border-t border-line-hi bg-[oklch(0.18_0_0)] outline-none shadow-[0_-12px_32px_rgb(0_0_0/.5)] ${props.size === 'full' ? 'h-[calc(100%-var(--cc-top)-12px)]' : ''}`}>
            <div onPointerDown={(e) => drag.start(e)} className="flex-none touch-none select-none">
              <div className="flex justify-center pt-2 pb-1"><span className="h-[5px] w-9 rounded-full bg-line-hi" /></div>
              {(props.title || props.actions) && (
                <div className="flex items-start gap-3 px-5 pt-2 pb-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {props.title && <h2 className="m-0 truncate text-[18px] font-semibold tracking-[-0.01em]">{props.title}</h2>}
                    {props.sub && <div className="truncate font-mono text-[12px] text-muted">{props.sub}</div>}
                  </div>
                  {props.actions}
                </div>
              )}
            </div>
            <div className={`cc-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain ${props.bodyClassName ?? 'px-5'}`} style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
              {props.children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Riga di menu dentro un foglio: 52 px, testo a sinistra, dettaglio e freccia a destra. */
export function SheetRow(props: { label: ReactNode; detail?: ReactNode; onClick: () => void; tone?: 'wait' | 'block'; chevron?: boolean }) {
  return (
    <button type="button" onClick={props.onClick}
      className={`flex min-h-[52px] w-full items-center gap-3 border-t border-line/70 text-left text-[15.5px] font-medium first:border-t-0 active:bg-panel-hi ${props.tone === 'wait' ? 'text-wait' : props.tone === 'block' ? 'text-block' : 'text-text'}`}>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.detail != null && <span className="flex-none font-mono text-[12.5px] text-muted">{props.detail}</span>}
      {props.chevron !== false && (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none text-muted"><path d="M9 6l6 6-6 6" /></svg>
      )}
    </button>
  );
}

/** Gruppo di pulsanti a scelta singola (controllo segmentato) da 44 px, per i fogli delle opzioni. */
export function Segmented<T extends string>(props: { label: string; value: T; options: { key: T; label: string; warn?: boolean }[]; onChange: (v: T) => void; mono?: boolean; columns?: number }) {
  return (
    <div role="radiogroup" aria-label={props.label} className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${props.columns ?? props.options.length}, minmax(0, 1fr))` }}>
      {props.options.map((o) => {
        const on = o.key === props.value;
        return (
          <button key={o.key} type="button" role="radio" aria-checked={on} onClick={() => props.onChange(o.key)}
            className={`min-h-11 truncate rounded-[10px] border px-2 text-[13.5px] font-medium transition-colors duration-150 ${props.mono ? 'font-mono text-[13px]' : ''} ${on ? (o.warn ? 'border-wait bg-wait/[.14] text-wait' : 'border-acid bg-acid text-ink') : 'border-line text-text active:bg-panel-hi'}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
