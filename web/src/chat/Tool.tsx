import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Disclosure } from '@heroui/react';
import { pop } from '../motion';
import { Orb } from '../ui';
import { canCopy, copyFile, downloadFile } from './fileActions';
import { CopyButton } from './CopyButton';
import { SourceChip, hostOf, searchLinks } from './Source';
import { ASK_TOOL, type ChatMessage, type ToolMeta } from '../../../shared/types';

// Riga di uno strumento usato dall'agente: Tool di prompt-kit (prompt-kit.com/docs/tool), con il Disclosure di HeroUI,
// lo stato a colpo d'occhio e, aperta, parametri e risultato in ordine.

const TOOL_COLOR: Record<string, string> = {
  Read: '#8FB7FF', Grep: '#8FB7FF', Glob: '#8FB7FF', LS: '#8FB7FF',
  Bash: '#A6FF00', Edit: '#FFB224', MultiEdit: '#FFB224', Write: '#FFB224', NotebookEdit: '#FFB224',
  WebFetch: '#C9A7FF', WebSearch: '#C9A7FF', Task: '#C9A7FF',
};

export function toolMeta(m: ChatMessage): ToolMeta | null {
  return m.meta?.kind === 'tool' ? m.meta : null;
}

/** Nome corto di uno strumento: mcp__claude_ai_Linear__list_issues → «list issues». */
export const shortTool = (tool: string) => (tool.startsWith('mcp__') ? tool.split('__').pop()!.replace(/_/g, ' ') : tool);

export type ToolState = 'run' | 'ok' | 'error' | 'skipped' | 'denied';

export function toolState(meta: ToolMeta): ToolState {
  if (!meta.done) return 'run';
  if (!meta.isError) return 'ok';
  // Domanda a scelte: «errore» vuol dire che l'hai saltata (o il giro è stato fermato).
  if (meta.tool === ASK_TOOL) return 'skipped';
  if (/ ha rifiutato( questo permesso|:)/.test(meta.output ?? '')) return 'denied';
  return 'error';
}

const STATE_LABEL: Record<ToolState, string> = { run: 'in corso', ok: 'fatto', error: 'errore', skipped: 'saltata', denied: 'rifiutato' };

function StateIcon({ state }: { state: ToolState }) {
  if (state === 'run') return <span className="-m-0.5 flex h-5 w-5 flex-none items-center justify-center"><Orb state="working" size={20} label="In corso" /></span>;
  const path = state === 'ok' ? <path d="M20 6 9 17l-5-5" /> : state === 'error' ? <path d="M18 6 6 18M6 6l12 12" /> : state === 'denied' ? <><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></> : <path d="M5 12h14" />;
  const color = state === 'ok' ? 'text-done' : state === 'error' ? 'text-block' : 'text-muted';
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`flex-none ${color}`}>{path}</svg>;
}

/** Diff semplice per Edit/Write a partire dall'input dello strumento. */
function editLines(meta: ToolMeta): { text: string; kind: 'add' | 'del' | 'ctx' }[] {
  const s = (k: string) => (typeof meta.input[k] === 'string' ? (meta.input[k] as string) : '');
  const lines: { text: string; kind: 'add' | 'del' | 'ctx' }[] = [];
  const push = (txt: string, kind: 'add' | 'del') => txt.split('\n').slice(0, 80).forEach((l) => lines.push({ text: `${kind === 'add' ? '+' : '-'} ${l}`, kind }));
  if (meta.tool === 'Write') push(s('content'), 'add');
  else if (meta.tool === 'MultiEdit' && Array.isArray(meta.input.edits)) {
    for (const e of meta.input.edits as { old_string?: string; new_string?: string }[]) { push(e.old_string ?? '', 'del'); push(e.new_string ?? '', 'add'); }
  } else { push(s('old_string'), 'del'); push(s('new_string'), 'add'); }
  return lines;
}

/** Campi dell'input già mostrati altrove (nel diff o come comando). */
const EDIT_KEYS = new Set(['old_string', 'new_string', 'content', 'edits']);

function formatValue(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v);
  return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
}

function Section({ title, tone, children }: { title: string; tone?: 'error'; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className={`text-[11px] font-semibold uppercase tracking-[.06em] ${tone === 'error' ? 'text-block' : 'text-muted'}`}>{title}</div>
      {children}
    </div>
  );
}

/** Parametri e risultato, in ordine: si monta solo quando la riga è aperta. */
function ToolBody({ meta, onOpenFile }: { meta: ToolMeta; onOpenFile: (path: string) => void }) {
  const isEdit = ['Edit', 'Write', 'MultiEdit'].includes(meta.tool);
  const isBash = meta.tool === 'Bash' && typeof meta.input.command === 'string';
  const params = Object.entries(meta.input).filter(([k, v]) => v != null && v !== '' && !(isEdit && EDIT_KEYS.has(k)) && !(isBash && (k === 'command' || k === 'description')));
  // Ricerche sul web: i risultati come etichette delle fonti, il resto dell'output sotto.
  const links = meta.tool === 'WebSearch' ? searchLinks(meta.output ?? '') : [];
  const output = links.length ? (meta.output ?? '').replace(/^Links: \[.*$/m, '').replace(/\n{3,}/g, '\n\n').trim() : meta.output ?? '';
  const outLines = output.split('\n');
  const state = toolState(meta);
  const failed = state === 'error' || state === 'denied';
  const mono = 'cc-wrap m-0 whitespace-pre-wrap font-mono text-[12px] leading-relaxed';
  return (
    <div className="cc-scroll flex max-h-[420px] flex-col gap-3 overflow-y-auto border-t border-line/70 px-3 py-2.5">
      {isBash && (
        <Section title="Comando">
          {typeof meta.input.description === 'string' && meta.input.description && <div className="text-[12.5px] text-soft">{meta.input.description}</div>}
          <pre className={`${mono} rounded-[6px] bg-ink px-2.5 py-1.5 text-text`}><span className="select-none text-acid">$ </span>{String(meta.input.command)}</pre>
        </Section>
      )}
      {params.length > 0 && (
        <Section title="Parametri">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {params.map(([k, v]) => (
              <div key={k} className="contents">
                <span className="font-mono text-[11.5px] leading-relaxed text-muted">{k}</span>
                {k === 'url' && typeof v === 'string' && hostOf(v)
                  ? <span className="flex min-w-0 flex-wrap items-center gap-2"><SourceChip url={v} /><span className={`${mono} min-w-0 text-muted`}>{v}</span></span>
                  : <span className={`${mono} text-soft`}>{formatValue(v)}</span>}
              </div>
            ))}
          </div>
        </Section>
      )}
      {isEdit && (
        <Section title={meta.tool === 'Write' ? 'Contenuto' : 'Modifiche'}>
          <div className="overflow-hidden rounded-[6px]">
            {editLines(meta).map((l, i) => (
              <div key={i} className={`${mono} px-1.5 ${l.kind === 'add' ? 'bg-done/10 text-[#9FE8C3]' : 'bg-block/10 text-[#FFB0A5]'}`}>{l.text}</div>
            ))}
          </div>
        </Section>
      )}
      {links.length > 0 && (
        <Section title={`Fonti · ${links.length}`}>
          <div className="flex flex-wrap gap-1.5">{links.map((l) => <SourceChip key={l.url} url={l.url} title={l.title} />)}</div>
        </Section>
      )}
      {!(isEdit && state === 'ok') && !(links.length && !output) && (
        <Section title={failed ? 'Errore' : 'Risultato'} tone={failed ? 'error' : undefined}>
          {output
            ? <pre className={`${mono} ${failed ? 'text-[#FFB0A5]' : 'text-soft'}`}>{outLines.slice(0, 300).join('\n')}{outLines.length > 300 ? `\n… altre ${outLines.length - 300} righe` : ''}</pre>
            : <div className="text-[12px] text-muted">{meta.done ? 'Nessun risultato.' : 'In corso…'}</div>}
        </Section>
      )}
      {typeof meta.input.file_path === 'string' && (
        <button type="button" onClick={() => onOpenFile(String(meta.input.file_path))} className="self-start text-[12px] text-acid hover:underline">Apri il file</button>
      )}
    </div>
  );
}

const DOWN_ICON = <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>;

/** Strumenti che creano o cambiano un file: accanto ad «Apri» anche Copia e Scarica. */
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Uno strumento: stato, nome e bersaglio; aperto, parametri e risultato. `current`: il passo a cui sta lavorando. */
export function ToolRow({ m, onOpenFile, fileUrl, current = false }: { m: ChatMessage; onOpenFile: (path: string) => void; fileUrl?: (path: string) => string | null; current?: boolean }) {
  const meta = toolMeta(m)!;
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(false);
  if (open && !seen) setSeen(true);
  const color = TOOL_COLOR[meta.tool] ?? 'oklch(0.72 0 0)';
  const state = toolState(meta);
  const isFile = typeof meta.input.file_path === 'string';
  const filePath = isFile ? String(meta.input.file_path) : '';
  const url = isFile && WRITES.has(meta.tool) ? fileUrl?.(filePath) ?? null : null;
  const ok = state === 'ok';
  const side = 'flex flex-none items-center gap-1 border-l border-line/70 px-2.5 text-[11.5px] text-muted hover:bg-panel-hi hover:text-acid';
  return (
    <Disclosure isExpanded={open} onExpandedChange={setOpen}
      className={`cc-in min-w-0 overflow-hidden rounded-[10px] border bg-[oklch(0.15_0_0)] transition-colors ${current && state === 'run' ? 'border-acid/45' : 'border-line/70'}`}>
      <div className="flex items-stretch">
        <Disclosure.Trigger aria-label={`${meta.tool} ${meta.target}: ${STATE_LABEL[state]}`}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left hover:bg-panel-hi">
          <StateIcon state={state} />
          <span className="flex-none rounded-[4px] px-1.5 py-0.5 font-mono text-[11px] font-medium" style={{ color, background: `color-mix(in oklch, ${color} 14%, transparent)` }}>{shortTool(meta.tool)}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-soft">{meta.target}</span>
          <span className={`hidden flex-none font-mono text-[11px] sm:inline ${state === 'error' ? 'text-block' : 'text-muted'}`}>{STATE_LABEL[state]}</span>
          <Disclosure.Indicator className="ms-0 size-3.5 text-muted" />
        </Disclosure.Trigger>
        {/* Come nella app di Claude: il file letto o scritto si apre con un clic. */}
        <AnimatePresence initial={false}>
        {isFile && ok && (
          <motion.button key="open" {...pop} type="button" onClick={() => onOpenFile(filePath)} aria-label={`Apri ${meta.target}`} title="Apri il file" className={side}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
            Apri
          </motion.button>
        )}
        {url && ok && canCopy(filePath) && (
          <motion.span key="copy" {...pop} className="flex flex-none border-l border-line/70">
            <CopyButton copy={() => copyFile(url, filePath)} label={`Copia ${meta.target}`} className="w-9 hover:bg-panel-hi hover:!text-acid" />
          </motion.span>
        )}
        {url && ok && (
          <motion.button key="down" {...pop} type="button" onClick={() => downloadFile(url)} aria-label={`Scarica ${meta.target}`} title="Scarica" className={side}>
            {DOWN_ICON}
          </motion.button>
        )}
        </AnimatePresence>
      </div>
      <Disclosure.Content>{seen && <ToolBody meta={meta} onOpenFile={onOpenFile} />}</Disclosure.Content>
    </Disclosure>
  );
}
