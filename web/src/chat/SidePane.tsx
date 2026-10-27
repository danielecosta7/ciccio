import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Disclosure, DisclosureGroup } from '@heroui/react';
import { collapse } from '../motion';
import { api } from '../api';
import { PcToolsSection } from './PcTools';
import { RoutinesSection } from '../Routines';
import { MODELS, PERMISSION_LEVELS, type AgentInfo, type AgentView, type ChatMessage, type ChatView, type DiffFile, type PermissionLevel } from '../../../shared/types';

export type PaneTab = 'chat' | 'diff' | 'status' | 'settings';

const TABS: { key: PaneTab; label: string }[] = [
  { key: 'chat', label: 'Chat' },
  { key: 'diff', label: 'Modifiche' },
  { key: 'status', label: 'STATUS.md' },
  { key: 'settings', label: 'Impostazioni' },
];

function ext(p: string) { return (p.split('/').pop()?.split('.').pop() ?? '').slice(0, 4).toUpperCase(); }

/** Elenco dei file del repo: un clic apre l'anteprima nel riquadro sopra la chat. */
function FileList({ agentId, chatId, selected, onSelect }: { agentId: string; chatId: string; selected: string | null; onSelect: (p: string) => void }) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { setFiles(null); void api.tree(agentId, chatId).then((r) => setFiles(r.files)).catch(() => setFiles([])); }, [agentId, chatId]);
  const shown = useMemo(() => (files ?? []).filter((f) => f.toLowerCase().includes(q.toLowerCase())).slice(0, 400), [files, q]);
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <label className="flex min-h-9 items-center rounded-[8px] border border-line bg-ink px-2.5">
          <span className="sr-only">Cerca file</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={files ? `Cerca tra ${files.length} file…` : 'Carico…'} className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted" />
        </label>
      </div>
      <div className="cc-scroll -mx-1.5 max-h-[360px] overflow-y-auto">
        {shown.map((f) => (
          <button key={f} type="button" onClick={() => onSelect(f)}
            className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-panel-hi pointer-coarse:min-h-11 ${f === selected ? 'bg-panel-hi' : ''}`}>
            <span className="w-10 flex-none rounded-[3px] bg-line/70 py-0.5 text-center font-mono text-[10px] text-soft">{ext(f) || '·'}</span>
            <span className="truncate font-mono text-[12.5px]">{f}</span>
          </button>
        ))}
        {files && shown.length === 0 && <div className="px-2 py-1.5 text-[13px] text-muted">Nessun file.</div>}
      </div>
    </div>
  );
}

function DiffTab({ agentId, chatId, refreshKey }: { agentId: string; chatId: string; refreshKey: number }) {
  const [data, setData] = useState<{ base: string | null; files: DiffFile[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { void api.diff(agentId, chatId).then(setData).catch(() => setData({ base: null, files: [] })); }, [agentId, chatId, refreshKey]);
  if (!data) return <div className="p-4 text-[13px] text-muted">Carico le modifiche…</div>;
  const added = data.files.reduce((s, f) => s + f.added, 0), removed = data.files.reduce((s, f) => s + f.removed, 0);
  return (
    <div className="cc-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3.5">
      <div className="font-mono text-[12px] text-muted">{data.files.length} file · <span className="text-done">+{added}</span> <span className="text-block">−{removed}</span> rispetto al branch principale</div>
      {data.files.length === 0 && <div className="text-[13px] text-muted">Nessuna modifica rispetto al branch principale.</div>}
      {data.files.map((f) => (
        <div key={f.path} className="overflow-hidden rounded-[8px] border border-line/70">
          <button type="button" onClick={() => setOpen(open === f.path ? null : f.path)} className="flex w-full items-center gap-2 bg-panel-hi px-2.5 py-2 text-left font-mono text-[12px]">
            <span className="min-w-0 flex-1 truncate">{f.path}</span>
            {f.patch ? <><span className="text-done">+{f.added}</span><span className="text-block">−{f.removed}</span></> : <span className="text-muted">nuovo</span>}
          </button>
          <AnimatePresence initial={false}>
          {open === f.path && f.patch && (
            <motion.div key="patch" {...collapse} className="overflow-hidden">
            <div className="cc-scroll max-h-[420px] overflow-y-auto py-1 font-mono text-[11.5px] leading-relaxed">
              {f.patch.split('\n').map((l, i) => (
                <div key={i} className={`cc-wrap whitespace-pre-wrap px-2.5 ${l.startsWith('+') && !l.startsWith('+++') ? 'bg-done/10 text-[#9FE8C3]' : l.startsWith('-') && !l.startsWith('---') ? 'bg-block/10 text-[#FFB0A5]' : l.startsWith('@@') ? 'text-[#8FB7FF]' : 'text-muted'}`}>{l}</div>
              ))}
            </div>
            </motion.div>
          )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}

// Sezioni apribili del pannello (DisclosureGroup di HeroUI, come in Impostazioni): da chiuse mostrano un
// riassunto; quali sono aperte si ricorda per scheda, su questo dispositivo.
function useOpenKeys(key: string, initial: string[]) {
  const [open, setOpen] = useState<Set<string>>(() => {
    try { const v = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown; if (Array.isArray(v)) return new Set(v.filter((x): x is string => typeof x === 'string')); } catch { /* memoria non disponibile */ }
    return new Set(initial);
  });
  const set = (keys: Set<string | number>) => {
    const next = new Set([...keys].map(String));
    setOpen(next);
    try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* memoria non disponibile */ }
  };
  return [open, set] as const;
}

function Sections({ storeKey, initial, children }: { storeKey: string; initial: string[]; children: (open: Set<string>) => ReactNode }) {
  const [open, setOpen] = useOpenKeys(storeKey, initial);
  return (
    <DisclosureGroup allowsMultipleExpanded expandedKeys={open} onExpandedChange={setOpen} className="cc-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5 [contain:none]">
      {children(open)}
    </DisclosureGroup>
  );
}

function Section({ id, title, summary, open, aside, children }: { id: string; title: string; summary?: ReactNode; open: boolean; aside?: ReactNode; children: ReactNode }) {
  // Il contenuto si monta alla prima apertura e poi resta, per l'animazione di chiusura.
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  return (
    // Sopra le sezioni dopo mentre la usi: i riquadri che si aprono sotto un pulsante restano davanti, cliccabili.
    <section className="relative flex-none rounded-[12px] border border-line bg-panel focus-within:z-20 hover:z-20">
      <Disclosure id={id}>
        {/* L'interruttore sta fuori dal pulsante (niente controlli dentro un pulsante) ma accanto alla freccia, come nelle altre righe. */}
        <div className="relative">
          <Disclosure.Heading level={3} className="m-0">
            <Disclosure.Trigger className="flex w-full items-center gap-2 rounded-[12px] py-2.5 pr-3 pl-3.5 text-left hover:bg-panel-hi/40 pointer-coarse:min-h-11">
              <span className={`flex min-w-0 flex-1 flex-col gap-px ${aside ? 'mr-12' : ''}`}>
                <span className="text-[13.5px] font-semibold">{title}</span>
                {!open && summary && <span className="truncate text-[12px] font-normal text-muted">{summary}</span>}
              </span>
              <Disclosure.Indicator className="size-4 flex-none text-muted" />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          {aside && <span className="absolute top-1/2 right-9 flex -translate-y-1/2">{aside}</span>}
        </div>
        <Disclosure.Content>
          <div className="flex flex-col gap-2.5 px-3.5 pb-3.5 text-[13px]">{seen && children}</div>
        </Disclosure.Content>
      </Disclosure>
    </section>
  );
}

function Toggle({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onChange}
      className={`relative h-[22px] w-[38px] flex-none rounded-full transition-colors duration-150 ${on ? 'bg-acid' : 'bg-line-hi'}`}>
      <span className={`absolute top-[3px] h-4 w-4 rounded-full transition-[left] duration-150 ${on ? 'left-[19px] bg-ink' : 'left-[3px] bg-soft'}`} />
    </button>
  );
}

const k = (n: number) => `${Math.round(n / 1000)}k`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-[92px] flex-none text-[12.5px] text-muted">{label}</dt>
      <dd className="m-0 min-w-0 flex-1 truncate" title={title}>{children}</dd>
    </div>
  );
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Link a file nelle risposte: [nome](percorso) senza schema (niente https:, mailto:, #ancora).
const FILE_LINK = /\]\((?!\w+:|#)([^)\s]+)\)/g;

type OutputFile = { path: string; how: 'scritto' | 'modificato' | 'mostrato'; ts: number };

/** File che la chat ha scritto, modificato o mostrato nelle risposte: il più recente in cima. */
function outputsOf(messages: ChatMessage[], dir: string | undefined): OutputFile[] {
  const rel = (p: string) => {
    const clean = p.replace(/^\.\//, '');
    return dir && clean.startsWith(`${dir}/`) ? clean.slice(dir.length + 1) : clean;
  };
  const seen = new Map<string, OutputFile>();
  const add = (p: string, how: OutputFile['how'], ts: number) => {
    let path: string;
    try { path = rel(decodeURI(p)); } catch { path = rel(p); }
    const prev = seen.get(path);
    // «scritto» vince su «modificato», che vince su «mostrato»; la data è l'ultima volta che è comparso.
    const rank = { scritto: 0, modificato: 1, mostrato: 2 };
    seen.set(path, { path, how: prev && rank[prev.how] < rank[how] ? prev.how : how, ts });
  };
  for (const m of messages) {
    if (m.meta?.kind === 'tool' && WRITE_TOOLS.has(m.meta.tool) && !m.meta.isError) {
      const p = m.meta.input.file_path ?? m.meta.input.notebook_path;
      if (typeof p === 'string') add(p, m.meta.tool === 'Write' ? 'scritto' : 'modificato', m.ts);
    } else if (m.role === 'agent') {
      for (const match of m.text.matchAll(FILE_LINK)) add(match[1], 'mostrato', m.ts);
    }
  }
  return [...seen.values()].sort((a, b) => b.ts - a.ts);
}

/** Come il pannello della sessione di Claude Code desktop: dove gira, quanto contesto ha, cosa ha prodotto. */
function ChatTab(props: {
  agent: AgentView; chat: ChatView; info: AgentInfo | null; messages: ChatMessage[]; contextWarn: number;
  selected: string | null; onOpenFile: (p: string) => void; onTab: (t: PaneTab) => void; onCompact: () => void; onNewSession: () => void;
}) {
  const { chat, info } = props;
  const model = MODELS.find((m) => m.id === chat.model)?.label ?? chat.model;
  const level = PERMISSION_LEVELS.find((l) => l.key === chat.permission);
  const c = chat.context;
  const pct = c?.pct ?? 0;
  const color = pct >= 95 ? '#FF6A55' : pct >= props.contextWarn ? '#FFB224' : pct >= 50 ? '#A6FF00' : 'oklch(0.72 0 0)';
  const outputs = useMemo(() => outputsOf(props.messages, info?.dir), [props.messages, info?.dir]);
  const loaded = [
    info?.claudeMd && 'CLAUDE.md',
    info?.statusMd && 'STATUS.md',
    info?.tools.length && plural(info.tools.length, 'strumento su misura', 'strumenti su misura'),
    info?.connectors && 'connettori di claude.ai',
    info?.pcTools && 'Companion',
  ].filter((x): x is string => typeof x === 'string');
  const shortDir = info ? info.dir.split('/').slice(-2).join('/') : '';
  return (
    <Sections storeKey="ciccio.pane.chat" initial={['env', 'context', 'output']}>
      {(open) => (
        <>
          <Section id="env" title="Ambiente" open={open.has('env')}
            summary={info ? `${info.worktree ? 'worktree della chat' : 'cartella del progetto'}${info.branch ? ` · ⎇ ${info.branch}` : ''}` : undefined}>
            <dl className="m-0 flex flex-col gap-1.5">
              <Row label="Dove">server di Ciccio, in sandbox</Row>
              <Row label="Cartella" title={info?.dir}><span className="font-mono text-[12px]">{info ? `…/${shortDir}` : '–'}</span></Row>
              <Row label="Lavora in">{info ? (info.worktree ? 'worktree tutto suo' : 'cartella del progetto') : '–'}</Row>
              <Row label="Branch"><span className="font-mono text-[12px]">{info?.branch ? `⎇ ${info.branch}` : '–'}</span></Row>
              <Row label="Modello">{model} <span className="text-muted">· {chat.effort}</span></Row>
              <Row label="Autorizzazioni">
                <button type="button" onClick={() => props.onTab('settings')} className={`hover:underline ${chat.permission === 'bypass' ? 'text-wait' : ''}`}>{level?.label ?? chat.permission}</button>
              </Row>
            </dl>
            {info?.worktree && <p className="m-0 text-[12px] leading-snug text-muted">Altre chat lavorano sullo stesso progetto: questa ha un worktree e un branch suoi, così non si pestano i file.</p>}
          </Section>

          <Section id="context" title="Contesto" open={open.has('context')}
            summary={c ? `${pct}% · ${k(c.used)} di ${k(c.max)} token` : 'si misura dopo il primo giro'}>
            <div className="flex items-center gap-2.5">
              <span className="flex h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
                <span className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
              </span>
              <span className="font-mono text-[12px]" style={{ color: c ? color : undefined }}>{c ? `${pct}%` : '–'}</span>
            </div>
            <div className="font-mono text-[12px] text-muted">
              {c ? `${k(c.used)} di ${k(c.max)} token` : 'Si misura dopo il primo giro.'}
              {info && <><br />Si comprime da sola oltre {k(info.autoCompactWindow)} token.</>}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button type="button" onClick={props.onCompact} disabled={!c || chat.running} className="cc-press min-h-9 rounded-[8px] border border-line-hi text-[13px] font-medium disabled:opacity-40 pointer-coarse:min-h-11">Comprimi</button>
              <button type="button" onClick={props.onNewSession} disabled={chat.running} className="cc-press min-h-9 rounded-[8px] border border-line-hi text-[13px] font-medium disabled:opacity-40 pointer-coarse:min-h-11">Nuova sessione</button>
            </div>
            {loaded.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12.5px] text-muted">Caricati nella sessione</span>
                <div className="flex flex-wrap gap-1.5">
                  {loaded.map((x) => <span key={x} className="rounded-[6px] border border-line bg-panel-hi px-2 py-0.5 text-[12px] text-soft">{x}</span>)}
                </div>
              </div>
            )}
          </Section>

          <Section id="output" title="Output" open={open.has('output')}
            summary={outputs.length ? plural(outputs.length, 'file', 'file') : 'ancora nessun file'}>
            {outputs.length === 0
              ? <div className="text-[12.5px] text-muted">I file che la chat scrive, modifica o ti mostra compaiono qui.</div>
              : (
                <div className="-mx-1.5 flex flex-col">
                  {outputs.map((f) => (
                    <button key={f.path} type="button" onClick={() => props.onOpenFile(f.path)} title={f.path}
                      className={`flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-panel-hi pointer-coarse:min-h-11 ${f.path === props.selected ? 'bg-panel-hi' : ''}`}>
                      <span className="w-10 flex-none rounded-[3px] bg-line/70 py-0.5 text-center font-mono text-[10px] text-soft">{ext(f.path) || '·'}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{f.path.split('/').pop()}</span>
                      <span className={`flex-none text-[11.5px] ${f.how === 'mostrato' ? 'text-muted' : 'text-done'}`}>{f.how}</span>
                    </button>
                  ))}
                </div>
              )}
            <button type="button" onClick={() => props.onTab('diff')} className="self-start text-[12.5px] text-muted hover:text-text">Tutte le modifiche al branch →</button>
          </Section>

          <Section id="files" title="File del progetto" open={open.has('files')} summary="cerca e apri qualsiasi file">
            <FileList agentId={props.agent.id} chatId={chat.id} selected={props.selected} onSelect={props.onOpenFile} />
          </Section>
        </>
      )}
    </Sections>
  );
}

function SettingsTab({ agent, chat, info, onRulesChanged }: { agent: AgentView; chat: ChatView; info: AgentInfo | null; onRulesChanged: () => void }) {
  const level = PERMISSION_LEVELS.find((l) => l.key === chat.permission);
  return (
    <Sections storeKey="ciccio.pane.settings" initial={['permission']}>
      {(open) => (
        <>
          <Section id="permission" title="Autorizzazioni di questa chat" open={open.has('permission')} summary={level?.label}>
            <div role="radiogroup" aria-label="Livello di autorizzazione" className="flex flex-col gap-1.5">
              {PERMISSION_LEVELS.map((l) => {
                const on = chat.permission === l.key;
                return (
                  <button key={l.key} type="button" role="radio" aria-checked={on} onClick={() => void api.setPermission(chat.id, l.key as PermissionLevel)}
                    className={`flex flex-col gap-0.5 rounded-[10px] border px-3 py-2 text-left ${on ? (l.key === 'bypass' ? 'border-wait/70 bg-wait/[.06]' : 'border-acid/70 bg-acid/[.05]') : 'border-line hover:border-line-hi'}`}>
                    <span className={`font-medium ${on && l.key === 'bypass' ? 'text-wait' : ''}`}>{l.label}</span>
                    <span className="text-[12px] leading-snug text-muted">{l.hint}</span>
                  </button>
                );
              })}
            </div>
            <div className="text-[12px] text-muted">Bloccati in ogni livello: push su main e force push fuori dai branch ciccio/.</div>
          </Section>

          <Section id="rules" title="Sempre consentiti" open={open.has('rules')}
            summary={info ? `${info.allowRules.length ? plural(info.allowRules.length, 'regola', 'regole') : 'nessuna regola'} · tutto il progetto` : undefined}>
            {!info?.allowRules.length && <div className="text-[12px] text-muted">Nessuna regola. Si aggiungono con «Consenti sempre» su una richiesta di permesso.</div>}
            <div className="flex flex-wrap gap-1.5">
              {info?.allowRules.map((r) => (
                <span key={r} className="inline-flex items-center gap-1.5 rounded-[6px] border border-line bg-panel-hi px-2 py-1 font-mono text-[11.5px]">
                  {r.replace(/^Bash:/, '')}
                  <button type="button" aria-label={`Togli la regola ${r}`} onClick={() => void api.removeRule(agent.id, r).then(onRulesChanged)} className="text-muted hover:text-text">×</button>
                </span>
              ))}
            </div>
          </Section>

          <Section id="tools" title="Strumenti su misura" open={open.has('tools')}
            summary={info ? `${info.tools.length ? plural(info.tools.length, 'strumento', 'strumenti') : 'nessuno'} · tutto il progetto` : undefined}>
            <div className="text-[12px] leading-snug text-muted">Li propongono gli agenti quando gli serve qualcosa che ripeteranno; li aggiungi tu con «Consenti sempre». Girano nella sandbox del progetto e si usano con il livello di ogni chat. Valgono dal prossimo messaggio.</div>
            {!info?.tools.length && <div className="text-[12px] text-muted">Nessuno strumento su misura.</div>}
            {info?.tools.map((t) => (
              <div key={t.name} className="flex flex-col gap-1 rounded-[8px] border border-line px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[12.5px]">{t.name} <span className="text-muted">· {t.kind === 'mcp' ? 'server MCP' : t.readOnly ? 'comando, sola lettura' : 'comando'}</span></span>
                  <button type="button" onClick={() => { if (confirm(`Togliere «${t.name}» dal progetto? Gli agenti non lo avranno più dal prossimo messaggio.`)) void api.removeProjectTool(agent.id, t.name).then(onRulesChanged); }}
                    className="flex-none text-[12px] text-muted hover:text-block">Togli</button>
                </div>
                <span className="text-[12px] leading-snug text-soft">{t.description}</span>
                <code className="cc-wrap whitespace-pre-wrap rounded-[6px] bg-ink px-2 py-1 font-mono text-[11.5px] text-muted">{t.detail}</code>
                <span className="text-[11.5px] text-muted">{t.uses ? `usato ${t.uses} volte` : 'mai usato'}{t.proposedIn ? ` · proposto in «${t.proposedIn}»` : ''}</span>
              </div>
            ))}
          </Section>

          <Section id="mcp" title="Server MCP del progetto" open={open.has('mcp')}
            summary={info ? (info.mcpServers.length ? `${info.mcpServers.join(', ')} · non caricati` : 'nessun .mcp.json') : undefined}>
            {info?.mcpServers.length ? <>
              {info.mcpServers.map((s) => <div key={s} className="rounded-[8px] border border-line px-3 py-2 font-mono text-[12px]">{s} <span className="text-muted">· .mcp.json</span></div>)}
              {/* Girerebbero nel processo di Claude Code, fuori dalla sandbox: le sessioni non li caricano (confine.ts). */}
              <div className="text-[12px] text-muted">Le chat non caricano i server di .mcp.json (girerebbero fuori dalla sandbox): l'agente può proporli con proponi_server_mcp, chiusi nella sandbox.</div>
            </>
              : <div className="text-[12px] text-muted">Nessun .mcp.json nel repo.</div>}
          </Section>

          <Section id="connectors" title="Connettori di claude.ai" open={open.has('connectors')}
            summary={info ? `${info.connectors ? 'accesi' : 'spenti'} · tutto il progetto` : undefined}
            aside={<Toggle on={!!info?.connectors} disabled={!info} label={info?.connectors ? 'Spegni i connettori per questo progetto' : 'Accendi i connettori per questo progetto'}
              onChange={() => info && void api.setConnectors(agent.id, !info.connectors).then(onRulesChanged)} />}>
            <div className="text-[12px] leading-snug text-muted">
              Gmail, Notion, Figma, i tuoi MCP e gli altri connettori del tuo account. Accesi, l'agente può leggere e agire sui tuoi dati.
              In Auto le letture passano da sole e le azioni (inviare, creare, modificare) chiedono conferma. Valgono dal prossimo messaggio.
            </div>
            {info?.connectors && (
              info.mcpStatus.length
                ? <div className="flex flex-col gap-1">{info.mcpStatus.map((m) => (
                    <div key={m.name} className="flex items-center justify-between gap-2 rounded-[8px] border border-line/70 px-2.5 py-1.5 font-mono text-[12px]">
                      <span className="truncate">{m.name}</span>
                      <span className={m.status === 'connected' ? 'text-done' : m.status === 'failed' ? 'text-block' : 'text-muted'}>{m.status}</span>
                    </div>
                  ))}</div>
                : <div className="text-[12px] text-muted">L'elenco dei connettori collegati compare dopo il prossimo messaggio all'agente.</div>
            )}
          </Section>

          <Section id="companion" title="Companion" open={open.has('companion')}
            summary={info ? `${info.pcTools ? 'acceso' : 'spento'} · programmi del PC, tutto il progetto` : undefined}
            aside={<Toggle on={!!info?.pcTools} disabled={!info} label={info?.pcTools ? 'Spegni il Companion per questo progetto' : 'Accendi il Companion per questo progetto'}
              onChange={() => info && void api.setPcTools(agent.id, !info.pcTools).then(onRulesChanged)} />}>
            <PcToolsSection enabled={info ? info.pcTools : null} onToggle={(on) => void api.setPcTools(agent.id, on).then(onRulesChanged)} global />
          </Section>

          <Section id="routines" title="Routine" open={open.has('routines')} summary="messaggi a orari fissi">
            <div className="text-[12px] leading-snug text-muted">Partono da sole con il livello delle chat nuove (o della chat scelta); il consumo e la soglia sull'uso sono in Impostazioni › Routine.</div>
            <RoutinesSection agents={[agent]} agentId={agent.id} />
          </Section>
        </>
      )}
    </Sections>
  );
}

export function SidePane(props: {
  agent: AgentView;
  chat: ChatView;
  info: AgentInfo | null;
  messages: ChatMessage[];
  contextWarn: number;
  tab: PaneTab;
  setTab: (t: PaneTab) => void;
  selectedFile: string | null;
  onOpenFile: (p: string) => void;
  onInfoChanged: () => void;
  onCompact: () => void;
  onNewSession: () => void;
  diffKey: number;
  onClose?: () => void;
  /** Dentro un foglio del telefono: schede a tutta larghezza da 44 px, sfondo del foglio. */
  compact?: boolean;
}) {
  return (
    <aside aria-label="Dettagli della chat" className={`flex h-full min-h-0 flex-col ${props.compact ? '' : 'bg-[oklch(0.145_0_0)]'}`}>
      <div role="tablist" className={`border-b border-line/70 ${props.compact ? 'grid grid-cols-4 gap-1 px-3 pb-2.5' : 'flex items-center gap-1 p-2.5 xl:min-h-(--cc-head)'}`}>
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={props.tab === t.key} onClick={() => props.setTab(t.key)}
            className={`truncate rounded-[8px] font-medium pointer-coarse:min-h-11 ${props.compact ? 'min-h-11 px-1 text-[13px]' : 'min-h-8 px-2.5 text-[12.5px]'} ${props.tab === t.key ? 'bg-acid text-ink' : 'text-soft hover:bg-panel-hi'}`}>{props.compact && t.key === 'settings' ? 'Progetto' : props.compact && t.key === 'status' ? 'STATUS' : t.label}</button>
        ))}
        {props.onClose && (
          <button type="button" onClick={props.onClose} aria-label="Chiudi il pannello" className="ml-auto flex h-8 w-8 items-center justify-center rounded-[8px] text-[18px] text-muted hover:bg-panel-hi pointer-coarse:h-11 pointer-coarse:w-11">×</button>
        )}
      </div>
      {/* Cambio di scheda: il contenuto nuovo entra con una breve dissolvenza. */}
      <div key={props.tab} className="cc-in flex min-h-0 flex-1 flex-col">
      {props.tab === 'chat' && <ChatTab agent={props.agent} chat={props.chat} info={props.info} messages={props.messages} contextWarn={props.contextWarn}
        selected={props.selectedFile} onOpenFile={props.onOpenFile} onTab={props.setTab} onCompact={props.onCompact} onNewSession={props.onNewSession} />}
      {props.tab === 'diff' && <DiffTab agentId={props.agent.id} chatId={props.chat.id} refreshKey={props.diffKey} />}
      {props.tab === 'status' && (
        <div className="cc-scroll min-h-0 flex-1 overflow-auto p-3.5">
          {props.info?.statusMd
            ? <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-soft">{props.info.statusMd}</pre>
            : <div className="text-[13px] text-muted">Nessuno STATUS.md: l'agente lo crea al primo giro.</div>}
        </div>
      )}
      {props.tab === 'settings' && <SettingsTab agent={props.agent} chat={props.chat} info={props.info} onRulesChanged={props.onInfoChanged} />}
      </div>
    </aside>
  );
}
