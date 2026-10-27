import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Disclosure } from '@heroui/react';
import { collapse, smooth } from '../motion';
import { shortTool, toolMeta, toolState } from './Tool';
import { ASK_TOOL, type ChatMessage } from '../../../shared/types';

// Passaggi di un giro: Steps e Chain of thought di prompt-kit (prompt-kit.com/docs/steps), con il Disclosure di HeroUI.
// Strumenti e ragionamento uno dopo l'altro stanno in un blocco chiuso («12 passaggi · Bash, Read, Edit…»); il testo
// dell'agente, i compiti, gli errori e le note restano fuori e spezzano il blocco.

/** Un passaggio: uno strumento (non le domande a scelte, che restano in vista) o un ragionamento. */
export const isStep = (m: ChatMessage) => m.role === 'thinking' || (m.meta?.kind === 'tool' && m.meta.tool !== ASK_TOOL);

/**
 * Note legate a un passaggio (permesso già dato o approvato, sub-agent su un altro modello): non spezzano il blocco e ci
 * stanno dentro. Rifiuti, blocchi, riavvii e le altre note restano in vista.
 */
export const isStepNote = (m: ChatMessage) => m.role === 'tool' && !m.meta && /^(✓ (già )?approvato|↳ sub-agent)/.test(m.text);

/** Messaggi in fila: un passaggio o più di fila diventano un gruppo (`run`), gli altri restano da soli. */
export interface Group { first: number; last: number; items: ChatMessage[]; run: boolean }

export function groupSteps(messages: ChatMessage[]): Group[] {
  const out: Group[] = [];
  messages.forEach((m, i) => {
    const prev = out[out.length - 1];
    if ((isStep(m) || isStepNote(m)) && prev?.run && prev.last === i - 1) { prev.items.push(m); prev.last = i; return; }
    out.push({ first: i, last: i, items: [m], run: isStep(m) });
  });
  return out;
}

/** Riassunto del blocco: quanti strumenti, quali (i primi tre) e quanti errori. */
export function stepsSummary(items: ChatMessage[]) {
  const tools = items.map(toolMeta).filter((t) => t != null);
  const names = [...new Set(tools.map((t) => shortTool(t.tool)))];
  const errors = tools.filter((t) => toolState(t) === 'error').length;
  return {
    count: tools.length,
    label: `${tools.length} ${tools.length === 1 ? 'passaggio' : 'passaggi'}`,
    names: `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`,
    errors: errors ? `${errors} ${errors === 1 ? 'errore' : 'errori'}` : '',
  };
}

/** Chiave stabile di un passaggio: il ragionamento in diretta e quello salvato sono lo stesso elemento. */
export const stepKey = (m: ChatMessage, prev?: ChatMessage) => (m.role === 'thinking' ? `pensa:${prev?.id ?? ''}` : String(m.id));

/** Altezza che segue il contenuto con la curva di Ciccio: quando il passo in vista cambia, niente salti. */
function AutoHeight({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | 'auto'>('auto');
  const reduce = useReducedMotion();
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div initial={false} animate={{ height: h }} transition={reduce ? { duration: 0 } : smooth} className="overflow-hidden">
      {/* flow-root: i margini del contenuto (mt-1.5 del passo) restano dentro la misura; prima ne uscivano e il
          fondo della card dello strumento aperta veniva tagliato di quei px. */}
      <div ref={inner} className="flow-root">{children}</div>
    </motion.div>
  );
}

const STEPS_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
    <path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth="3" />
  </svg>
);

/**
 * Blocco dei passaggi. Chiuso di serie; mentre l'agente ci lavora (`live`) sotto il titolo resta in vista il passo
 * in corso, evidenziato. A fine giro resta solo il titolo; un clic apre tutto, con la barra a sinistra.
 */
export function Steps({ items, live, renderStep }: {
  items: ChatMessage[];
  live: boolean;
  renderStep: (m: ChatMessage, current: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(false);
  if (open && !seen) setSeen(true);
  const s = stepsSummary(items);
  // Il passo in corso è l'ultimo strumento o ragionamento, non la nota che lo segue (permesso approvato).
  const last = items.findLast(isStep) ?? items[items.length - 1];
  const keyed = (m: ChatMessage, i: number, current: boolean) => <Fragment key={stepKey(m, items[i - 1])}>{renderStep(m, current)}</Fragment>;
  return (
    <div className="flex min-w-0 flex-col">
      <Disclosure isExpanded={open} onExpandedChange={setOpen} className="min-w-0">
        <Disclosure.Trigger aria-label={`${s.label}: ${s.names}${s.errors ? `, ${s.errors}` : ''}. ${open ? 'Chiudi' : 'Apri'} i passaggi`}
          className="flex w-full min-w-0 items-center gap-2 rounded-[6px] py-1 text-left text-[13px] text-muted hover:text-soft">
          {STEPS_ICON}
          <span className="flex-none font-medium text-soft">{s.label}</span>
          {s.names && <span className="min-w-0 truncate font-mono text-[12px]">· {s.names}</span>}
          {s.errors && <span className="flex-none text-[12px] text-block">· {s.errors}</span>}
          <Disclosure.Indicator className="ms-0 size-3.5 flex-none text-muted" />
        </Disclosure.Trigger>
        <Disclosure.Content>
          {seen && (
            <div className="ml-[6px] mt-1.5 flex min-w-0 flex-col gap-1.5 border-l-2 border-line pb-0.5 pl-3.5">
              {items.map((m, i) => keyed(m, i, live && m === last))}
            </div>
          )}
        </Disclosure.Content>
      </Disclosure>
      {/* Il passo in corso, sotto il titolo chiuso: cambia al passo dopo e sparisce a fine giro o quando l'agente scrive. */}
      <AnimatePresence initial={false}>
        {live && !open && (
          <motion.div key="ora" {...collapse} className="overflow-hidden">
            <AutoHeight>
              <div className="ml-[6px] mt-1.5 border-l-2 border-acid/40 pl-3.5">{keyed(last, items.indexOf(last), true)}</div>
            </AutoHeight>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
