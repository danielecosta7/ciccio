import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';

export interface WizardStep {
  title: string;
  /** Contenuto del passo: spiega cosa succede e fa fare la cosa. */
  body: ReactNode;
  /** Si può andare avanti (es. file scaricato, collegamento riuscito). Di default sì. */
  canNext?: boolean;
  /** Etichetta del pulsante per andare avanti (es. "L'ho installato"). */
  next?: string;
}

/**
 * Procedura guidata: un passo alla volta, con la barra dei passi in alto, Indietro e Avanti.
 * Collega servizi esterni e intanto spiega cosa stai facendo.
 */
export function Wizard(props: { steps: WizardStep[]; onDone?: () => void; doneLabel?: string; start?: number }) {
  const [i, setI] = useState(props.start ?? 0);
  const [dir, setDir] = useState(1);
  const step = props.steps[Math.min(i, props.steps.length - 1)];
  const last = i >= props.steps.length - 1;
  const go = (n: number) => { setDir(n > i ? 1 : -1); setI(n); };
  return (
    <div className="flex flex-col gap-3.5 rounded-[12px] border border-line bg-ink/40 p-4">
      <ol className="m-0 flex list-none gap-1 p-0" aria-label="Passi">
        {props.steps.map((s, n) => (
          <li key={s.title} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className={`h-[3px] w-full transition-colors duration-300 ${n <= i ? 'bg-acid' : 'bg-line-hi'}`} />
            <span className={`truncate text-[11px] ${n === i ? 'font-semibold text-text' : 'text-muted'}`} aria-current={n === i ? 'step' : undefined}>{n + 1}. {s.title}</span>
          </li>
        ))}
      </ol>
      <div className="relative min-h-[60px] overflow-hidden">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.div key={i} custom={dir}
            initial={{ opacity: 0, x: dir * 24 }} animate={{ opacity: 1, x: 0, transition: { duration: 0.24, ease: [0.25, 1, 0.5, 1] } }}
            exit={{ opacity: 0, x: dir * -24, transition: { duration: 0.14 } }}
            className="flex flex-col gap-2.5 text-[13.5px] leading-relaxed text-soft">
            {step.body}
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => go(i - 1)} disabled={i === 0}
          className="cc-press min-h-10 rounded-[10px] px-3 text-[13.5px] text-muted hover:text-text disabled:invisible">Indietro</button>
        {last
          ? props.onDone && <button type="button" onClick={props.onDone} className="cc-press min-h-10 rounded-[10px] bg-acid px-4 text-[13.5px] font-semibold text-ink">{props.doneLabel ?? 'Fatto'}</button>
          : <button type="button" onClick={() => go(i + 1)} disabled={step.canNext === false}
              className="cc-press min-h-10 rounded-[10px] bg-acid px-4 text-[13.5px] font-semibold text-ink disabled:opacity-40">{step.next ?? 'Avanti'}</button>}
      </div>
    </div>
  );
}
