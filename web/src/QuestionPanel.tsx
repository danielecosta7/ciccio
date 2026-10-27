import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { collapse, quick, smooth } from './motion';
import { ASK_TOOL, questionsOf, type Approval, type Question } from '../../shared/types';

/** Prima domanda a scelte in attesa tra le richieste di una chat. */
export function pendingQuestion(approvals: Approval[]): Approval | undefined {
  return approvals.find((a) => a.status === 'pending' && a.tool === ASK_TOOL && questionsOf(a));
}

/** Richieste di permesso vere (le domande hanno la loro finestra sopra il campo di testo). */
export const onlyPermissions = (approvals: Approval[]) => approvals.filter((a) => a.tool !== ASK_TOOL);

interface Pick { choices: string[]; other: string; skipped: boolean }
const EMPTY: Pick = { choices: [], other: '', skipped: false };

/** Claude segna l'opzione che consiglia con «(Recommended)»: qui diventa un'etichetta in italiano. */
const RECOMMENDED = /\s*\((recommended|consigliat[ao])\)\s*$/i;

/** Risposta di una domanda come la vuole Claude: scelte separate da virgola, più il testo libero. */
function answerText(q: Question, p: Pick): string {
  const other = p.other.trim();
  if (!q.multiSelect && other) return other;
  return [...p.choices, ...(other ? [other] : [])].join(', ');
}

/**
 * Finestra delle domande a scelte (AskUserQuestion), come nell'app di Claude: opzioni numerate con
 * descrizione, scelta multipla, «Qualcos'altro» con testo libero, «Salta», «2 di 3» tra più domande.
 * Tastiera: 1-4 sceglie, ↑↓ si muove, Invio conferma, ←→ cambia domanda, Esc salta.
 */
export function QuestionPanel(props: {
  approval: Approval;
  /** Chi chiede (nome dell'agente o Ciccio). */
  from: string;
  /** Risposte per testo della domanda; vuoto = tutte saltate. */
  onAnswer: (id: string, answers: Record<string, string>) => Promise<void>;
  /** Pannelli stretti (pannello dell'agente, chat con Ciccio): meno margini. */
  compact?: boolean;
}) {
  const { approval } = props;
  const questions = questionsOf(approval) ?? [];
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(() => EMPTY));
  const [cursor, setCursor] = useState(0);
  const [dir, setDir] = useState(1);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const box = useRef<HTMLElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** Porta la tastiera su un'opzione (l'evidenziazione la segue). */
  const focusOption = (i: number) => { const el = optionRefs.current[i]; if (el) el.focus({ preventScroll: false }); else box.current?.focus({ preventScroll: true }); };
  const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const q = questions[index];
  const pick = picks[index] ?? EMPTY;
  const last = index === questions.length - 1;

  // Domanda nuova: si riparte dalla prima e, al computer, la finestra prende la tastiera,
  // ma non se stai scrivendo in un altro campo (un «1» digitato lì sceglierebbe un'opzione).
  useEffect(() => {
    setIndex(0); setPicks(questions.map(() => EMPTY)); setCursor(0); setError('');
    const el = document.activeElement;
    const writing = (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && el.value.trim() !== '';
    if (!touch && !writing) requestAnimationFrame(() => focusOption(0));
  }, [approval.id]);

  if (!q) return null;

  const submit = async (all: Pick[]) => {
    const answers: Record<string, string> = {};
    questions.forEach((x, i) => { const t = all[i] && !all[i].skipped ? answerText(x, all[i]) : ''; if (t) answers[x.question] = t; });
    setSending(true); setError('');
    try { await props.onAnswer(approval.id, answers); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setSending(false); }
  };

  const go = (to: number) => {
    if (to < 0 || to >= questions.length) return;
    setDir(to > index ? 1 : -1); setIndex(to); setCursor(0);
    // La domanda nuova entra dopo l'uscita della vecchia: la tastiera la raggiunge appena c'è.
    if (!touch) setTimeout(() => focusOption(0), 200);
  };

  /** Chiude la domanda corrente con questa scelta: avanti alla prossima, o invia tutto all'ultima. */
  const commit = (p: Pick) => {
    const all = picks.map((x, i) => (i === index ? p : x));
    setPicks(all);
    if (last) void submit(all); else go(index + 1);
  };

  const choose = (i: number) => {
    const label = q.options[i]?.label;
    if (!label || sending) return;
    setCursor(i);
    if (!q.multiSelect) { commit({ choices: [label], other: '', skipped: false }); return; }
    const choices = pick.choices.includes(label) ? pick.choices.filter((c) => c !== label) : [...pick.choices, label];
    setPicks(picks.map((x, n) => (n === index ? { ...x, choices, skipped: false } : x)));
  };

  const skip = () => commit({ ...EMPTY, skipped: true });
  /** Invio: conferma quello che c'è; senza niente, sulle opzioni sceglie quella evidenziata. */
  const confirm = (typing = false) => {
    if (pick.other.trim() || pick.choices.length) commit({ ...pick, skipped: false });
    else if (!typing && !q.multiSelect && q.options[cursor]) choose(cursor);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (sending || e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = e.target === otherRef.current;
    // Esc salta la domanda e non arriva alle pagine (che chiuderebbero pannello o chat).
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skip(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirm(typing); return; }
    if (typing) {
      if (e.key === 'ArrowUp') { e.preventDefault(); focusOption(q.options.length - 1); }
      return;
    }
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= q.options.length) { e.preventDefault(); if (q.multiSelect) focusOption(n - 1); choose(n - 1); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cursor >= q.options.length - 1) otherRef.current?.focus(); else focusOption(cursor + 1);
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusOption(Math.max(0, cursor - 1)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
  };

  const pad = props.compact ? 'px-3' : 'px-3.5 sm:px-4';
  const arrow = 'cc-press flex h-8 w-8 items-center justify-center rounded-[8px] text-muted hover:text-text disabled:opacity-30 disabled:hover:text-muted';

  return (
    <section ref={box} tabIndex={-1} onKeyDown={onKeyDown} aria-label={`Domanda di ${props.from}`}
      className="cc-glow flex flex-col overflow-hidden rounded-[14px] border border-wait/45 bg-panel outline-none focus-visible:border-wait">
      <header className={`flex items-start gap-2 ${pad} pt-3 pb-2`}>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-mono text-[11px] font-medium tracking-wide text-wait uppercase">{q.header || `Domanda di ${props.from}`}</span>
          <AnimatePresence mode="wait" initial={false} custom={dir}>
            <motion.h2 key={index} initial={{ opacity: 0, x: 10 * dir }} animate={{ opacity: 1, x: 0, transition: smooth }} exit={{ opacity: 0, x: -10 * dir, transition: quick }}
              className="cc-wrap m-0 text-[15px] leading-snug font-semibold text-text">{q.question}</motion.h2>
          </AnimatePresence>
        </div>
        {questions.length > 1 && (
          <nav aria-label="Domande" className="flex flex-none items-center font-mono text-[12px] text-muted">
            <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Domanda precedente" className={arrow}>‹</button>
            <span aria-live="polite" className="px-0.5 whitespace-nowrap">{index + 1} di {questions.length}</span>
            <button type="button" onClick={() => go(index + 1)} disabled={last} aria-label="Domanda successiva" className={arrow}>›</button>
          </nav>
        )}
        <button type="button" onClick={() => void submit([])} disabled={sending} aria-label="Salta tutte le domande" title="Salta tutte (Claude va avanti da solo)" className={`${arrow} flex-none`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>

      <AnimatePresence mode="wait" initial={false} custom={dir}>
        <motion.div key={index} initial={{ opacity: 0, x: 14 * dir }} animate={{ opacity: 1, x: 0, transition: smooth }} exit={{ opacity: 0, x: -14 * dir, transition: quick }}
          role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}
          className={`cc-scroll flex max-h-[min(46dvh,420px)] flex-col overflow-y-auto overscroll-contain ${props.compact ? 'px-1.5' : 'px-2'}`}>
          {q.options.map((o, i) => {
            const on = pick.choices.includes(o.label);
            const hot = i === cursor && !touch;
            return (
              <button key={o.label} ref={(el) => { optionRefs.current[i] = el; }} type="button" role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on}
                onClick={() => choose(i)} onMouseEnter={() => setCursor(i)} onFocus={() => setCursor(i)} disabled={sending}
                className={`group flex w-full items-start gap-3 rounded-[10px] px-2 py-2.5 text-left transition-colors duration-150 ${on ? 'bg-acid/[.09]' : hot ? 'bg-panel-hi' : 'hover:bg-panel-hi'}`}>
                <span className={`mt-px flex h-6 w-6 flex-none items-center justify-center rounded-[6px] border font-mono text-[12px] font-semibold transition-colors duration-150 ${on ? 'border-acid bg-acid text-ink' : 'border-line-hi bg-ink text-soft'}`} aria-hidden="true">
                  {on && q.multiSelect ? '✓' : i + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={`cc-wrap text-[14px] leading-snug ${on ? 'font-semibold text-text' : 'text-text'}`}>
                    {o.label.replace(RECOMMENDED, '')}
                    {RECOMMENDED.test(o.label) && <span className="ml-2 inline-block rounded-[4px] bg-acid/15 px-1.5 py-px align-[1px] font-mono text-[10.5px] font-medium text-acid">consigliata</span>}
                  </span>
                  {o.description && <span className="cc-wrap text-[12.5px] leading-snug text-muted">{o.description}</span>}
                </span>
              </button>
            );
          })}
        </motion.div>
      </AnimatePresence>

      <div className={`flex items-center gap-2 ${props.compact ? 'mx-1.5' : 'mx-2'} mt-1 mb-2 rounded-[10px] border border-line bg-ink py-1 pr-1 pl-2.5 focus-within:border-acid/60`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none text-muted"><path d="M4 20h4L19 9l-4-4L4 16v4z" /></svg>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Qualcos'altro: risposta scritta da te</span>
          <input ref={otherRef} value={pick.other} disabled={sending}
            onChange={(e) => { const other = e.target.value; setPicks(picks.map((x, n) => (n === index ? { ...x, other, skipped: false } : x))); }}
            placeholder="Qualcos'altro…" enterKeyHint={last ? 'send' : 'next'}
            className="h-9 w-full bg-transparent text-[14px] text-text outline-none placeholder:text-muted" />
        </label>
        <AnimatePresence initial={false} mode="popLayout">
          {pick.other.trim() || pick.choices.length ? (
            <motion.button key="ok" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1, transition: quick }} exit={{ opacity: 0, scale: 0.92, transition: quick }}
              type="button" onClick={() => confirm()} disabled={sending}
              className="cc-press h-8 flex-none rounded-[8px] bg-acid px-3 text-[13px] font-semibold text-ink">{last ? 'Invia' : 'Avanti'}</motion.button>
          ) : (
            <motion.button key="skip" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1, transition: quick }} exit={{ opacity: 0, scale: 0.92, transition: quick }}
              type="button" onClick={skip} disabled={sending}
              className="cc-press h-8 flex-none rounded-[8px] border border-line-hi px-3 text-[13px] text-soft hover:text-text">Salta</motion.button>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence initial={false}>
        {error && <motion.div key="err" {...collapse} className="overflow-hidden"><div className={`${pad} pb-2 text-[12.5px] text-block`}>{error}</div></motion.div>}
      </AnimatePresence>
      {!touch && !props.compact && (
        <div className={`hidden flex-wrap gap-x-3 ${pad} pb-2.5 font-mono text-[11px] text-muted sm:flex`} aria-hidden="true">
          <span>1-{q.options.length} sceglie{q.multiSelect ? ' (più di una)' : ''}</span><span>Invio conferma</span>{questions.length > 1 && <span>←→ domande</span>}<span>Esc salta</span>
        </div>
      )}
    </section>
  );
}

/** La finestra nel flusso della pagina, sopra il campo di testo: si apre e si chiude in altezza. */
export function QuestionSlot(props: { approvals: Approval[]; from: string; onAnswer: (id: string, answers: Record<string, string>) => Promise<void>; compact?: boolean; className?: string }) {
  const a = pendingQuestion(props.approvals);
  return (
    <AnimatePresence initial={false}>
      {a && (
        <motion.div key={a.id} {...collapse} className="flex-none overflow-hidden">
          <div className={props.className}>
            <QuestionPanel approval={a} from={props.from} onAnswer={props.onAnswer} compact={props.compact} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
