import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { collapse } from './motion';
import { api, timeAgo } from './api';
import { describeCron, nextRuns, parseCron } from '../../shared/cron';
import { timeZone } from '../../shared/tz';
import { PERMISSION_LEVELS, type AgentView, type PermissionLevel, type RoutineRun, type RoutineUsage, type RoutineView } from '../../shared/types';

// Routine: messaggi che il server manda da solo a un progetto a orari fissi. Qui l'elenco (con prossima
// esecuzione, ultimo esito e consumo), il modulo per crearle o cambiarle e lo storico delle esecuzioni.
// Lo stesso componente sta nelle Impostazioni (tutti i progetti) e nel pannello del progetto (solo quello).

/** Routine dal server, aggiornate in diretta (evento «routines» del canale). */
export function useRoutines(agentId?: string) {
  const [list, setList] = useState<RoutineView[] | null>(null);
  useEffect(() => {
    let alive = true;
    void api.routines(agentId).then((l) => { if (alive) setList(l); }).catch(() => { if (alive) setList([]); });
    const on = (e: Event) => setList((e as CustomEvent<RoutineView[]>).detail.filter((r) => !agentId || r.agentId === agentId));
    window.addEventListener('ciccio:routines', on);
    return () => { alive = false; window.removeEventListener('ciccio:routines', on); };
  }, [agentId]);
  return list;
}

const field = 'min-h-10 rounded-[10px] border border-line bg-ink px-3 text-[14px] text-text outline-none hover:border-line-hi focus:border-acid';
const button = 'cc-press min-h-9 rounded-[8px] border border-line-hi px-3 text-[13px] text-soft hover:text-text disabled:opacity-40';
const DAYS: [number, string][] = [[1, 'lun'], [2, 'mar'], [3, 'mer'], [4, 'gio'], [5, 'ven'], [6, 'sab'], [0, 'dom']];

const when = (ms: number) => new Intl.DateTimeFormat('it-IT', { timeZone: timeZone(), weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const usageLine = (u: RoutineUsage) => (u.runs ? `${u.runs} esecuzion${u.runs === 1 ? 'e' : 'i'} · ${tokens(u.tokensIn)} token letti, ${tokens(u.tokensOut)} scritti · ≈ ${u.costUsd.toFixed(2)} $` : 'nessuna esecuzione');

const STATUS: Record<RoutineRun['status'], { label: string; cls: string }> = {
  in_corso: { label: 'al lavoro', cls: 'text-acid' },
  in_coda: { label: 'in coda', cls: 'text-wait' },
  ok: { label: 'ok', cls: 'text-done' },
  errore: { label: 'errore', cls: 'text-block' },
  fermata: { label: 'fermata', cls: 'text-muted' },
  saltata: { label: 'saltata', cls: 'text-wait' },
  interrotta: { label: 'interrotta', cls: 'text-muted' },
};

// ── Orario ────────────────────────────────────────────────────────────────

type Mode = 'giorno' | 'settimana' | 'ore' | 'cron';
interface Sched { mode: Mode; time: string; days: number[]; hours: number; minute: number; cron: string }

function toCron(s: Sched): string {
  const [h, m] = s.time.split(':').map(Number);
  if (s.mode === 'giorno') return `${m} ${h} * * *`;
  if (s.mode === 'settimana') return `${m} ${h} * * ${[...s.days].sort((a, b) => a - b).join(',') || '1'}`;
  if (s.mode === 'ore') return `${s.minute} ${s.hours === 1 ? '*' : `*/${s.hours}`} * * *`;
  return s.cron.trim();
}

/** Dal cron salvato alla forma del modulo: le forme semplici tornano nei loro campi, il resto resta cron. */
function fromCron(cron: string): Sched {
  const base: Sched = { mode: 'giorno', time: '08:00', days: [1], hours: 4, minute: 0, cron };
  const p = cron.split(' ');
  const t = (h: string, m: string) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  if (p.length === 5 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1]) && p[2] === '*' && p[3] === '*') {
    if (p[4] === '*') return { ...base, mode: 'giorno', time: t(p[1], p[0]) };
    if (/^[0-6](,[0-6])*$/.test(p[4])) return { ...base, mode: 'settimana', time: t(p[1], p[0]), days: p[4].split(',').map(Number) };
  }
  const every = /^(\d+) (\*|\*\/(\d+)) \* \* \*$/.exec(cron);
  if (every) return { ...base, mode: 'ore', minute: Number(every[1]), hours: every[3] ? Number(every[3]) : 1 };
  return { ...base, mode: 'cron' };
}

function SchedulePicker({ value, onChange }: { value: Sched; onChange: (s: Sched) => void }) {
  const set = (p: Partial<Sched>) => onChange({ ...value, ...p });
  const cron = toCron(value);
  let preview: { ok: true; text: string; next: number[] } | { ok: false; text: string };
  try { preview = { ok: true, text: describeCron(cron), next: nextRuns(parseCron(cron), Date.now(), 3) }; }
  catch (e) { preview = { ok: false, text: e instanceof Error ? e.message : String(e) }; }
  return (
    <div className="flex flex-col gap-2.5">
      <div role="radiogroup" aria-label="Quando" className="flex flex-wrap gap-1.5">
        {([['giorno', 'Ogni giorno'], ['settimana', 'Giorni della settimana'], ['ore', 'Ogni N ore'], ['cron', 'Cron']] as [Mode, string][]).map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={value.mode === k} onClick={() => set({ mode: k, cron: k === 'cron' ? cron : value.cron })}
            className={`cc-press min-h-9 rounded-[8px] px-3 text-[13px] ${value.mode === k ? 'bg-acid font-semibold text-ink' : 'border border-line text-soft hover:text-text'}`}>{l}</button>
        ))}
      </div>
      {value.mode === 'settimana' && (
        <div className="flex flex-wrap gap-1.5" aria-label="Giorni">
          {DAYS.map(([d, l]) => {
            const on = value.days.includes(d);
            return (
              <button key={d} type="button" aria-pressed={on} onClick={() => set({ days: on ? value.days.filter((x) => x !== d) : [...value.days, d] })}
                className={`cc-press h-9 w-12 rounded-[8px] text-[13px] ${on ? 'border border-acid/70 bg-acid/[.08] text-text' : 'border border-line text-muted hover:text-text'}`}>{l}</button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-soft">
        {(value.mode === 'giorno' || value.mode === 'settimana') && (
          <label className="flex items-center gap-2">alle <input type="time" value={value.time} onChange={(e) => set({ time: e.target.value || '08:00' })} className={`${field} w-[120px]`} /></label>
        )}
        {value.mode === 'ore' && (
          <>
            <label className="flex items-center gap-2">ogni
              <select value={value.hours} onChange={(e) => set({ hours: Number(e.target.value) })} className={field}>
                {[1, 2, 3, 4, 6, 8, 12].map((h) => <option key={h} value={h}>{h === 1 ? 'ora' : `${h} ore`}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2">al minuto <input type="number" min={0} max={59} value={value.minute} onChange={(e) => set({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} className={`${field} w-[80px]`} /></label>
          </>
        )}
        {value.mode === 'cron' && (
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[12px] text-muted">minuto ora giorno mese giorno-della-settimana, fuso {timeZone()} (es. 30 7 * * 1-5)</span>
            <input value={value.cron} onChange={(e) => set({ cron: e.target.value })} spellCheck={false} className={`${field} font-mono`} />
          </label>
        )}
      </div>
      <div className={`text-[12.5px] ${preview.ok ? 'text-muted' : 'text-block'}`} aria-live="polite">
        {preview.ok ? <>{preview.text}{preview.next.length ? ` · prossime: ${preview.next.map(when).join(', ')}` : ' · nessuna esecuzione nel prossimo anno'}</> : preview.text}
      </div>
    </div>
  );
}

// ── Modulo ────────────────────────────────────────────────────────────────

function RoutineForm(props: { agents: AgentView[]; agentId?: string; routine?: RoutineView; onDone: () => void }) {
  const r = props.routine;
  const [agentId, setAgentId] = useState(r?.agentId ?? props.agentId ?? props.agents[0]?.id ?? '');
  const [name, setName] = useState(r?.name ?? '');
  const [text, setText] = useState(r?.text ?? '');
  const [chatId, setChatId] = useState<string>(r?.chatId ?? '');
  const [permission, setPermission] = useState<PermissionLevel | ''>(r?.permission ?? '');
  const [sched, setSched] = useState<Sched>(() => fromCron(r?.cron ?? '0 8 * * *'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const agent = props.agents.find((a) => a.id === agentId);
  // Le chat delle routine stesse (⏱) non hanno senso come chat fissa.
  const chats = (agent?.chats ?? []).filter((c) => !c.title.startsWith('⏱'));

  const submit = async () => {
    setBusy(true); setError('');
    const body = { name, text, cron: toCron(sched), chatId: chatId || null, permission: permission || null };
    try {
      if (r) await api.updateRoutine(r.id, body); else await api.createRoutine({ ...body, agentId });
      props.onDone();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3 rounded-[12px] border border-line bg-ink/40 p-3.5">
      <div className="grid gap-3 sm:grid-cols-2">
        {!props.agentId && !r && (
          <label className="flex flex-col gap-1 text-[12.5px] text-muted">Progetto
            <select value={agentId} onChange={(e) => { setAgentId(e.target.value); setChatId(''); }} className={field}>
              {props.agents.filter((a) => !a.hidden).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-[12.5px] text-muted">Nome
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="es. Punto delle PR" className={field} />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] text-muted sm:col-span-2">Dove
          <select value={chatId} onChange={(e) => setChatId(e.target.value)} className={field}>
            <option value="">Una chat nuova a ogni esecuzione (senza contesto)</option>
            {chats.map((c) => <option key={c.id} value={c.id}>Sempre in «{c.title}» (con la sua sessione)</option>)}
          </select>
        </label>
        {!chatId && (
          <label className="flex flex-col gap-1 text-[12.5px] text-muted sm:col-span-2">Livello delle chat nuove
            <select value={permission} onChange={(e) => setPermission(e.target.value as PermissionLevel | '')} className={field}>
              <option value="">Come le altre chat nuove (Impostazioni › Chat)</option>
              {PERMISSION_LEVELS.map((l) => <option key={l.key} value={l.key} title={l.hint}>{l.label}</option>)}
            </select>
            <span className="text-[12px] leading-snug">In Manuale la routine si ferma a ogni permesso (anche per aggiornare STATUS.md) finché non rispondi.</span>
          </label>
        )}
      </div>
      <label className="flex flex-col gap-1 text-[12.5px] text-muted">Messaggio per l'agente
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={8000}
          placeholder="Scrivilo come lo scriveresti tu: parte da solo, l'agente non può chiederti chiarimenti al momento."
          className="cc-scroll min-h-24 resize-y rounded-[10px] border border-line bg-ink px-3 py-2 text-[14px] leading-relaxed text-text outline-none hover:border-line-hi focus:border-acid" />
      </label>
      <SchedulePicker value={sched} onChange={setSched} />
      {error && <div className="text-[12.5px] text-block">{error}</div>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy || !name.trim() || !text.trim() || !agentId} className="cc-press min-h-9 rounded-[8px] bg-acid px-3.5 text-[13px] font-semibold text-ink disabled:opacity-40">{r ? 'Salva' : 'Crea routine'}</button>
        <button type="button" onClick={props.onDone} className={button}>Annulla</button>
      </div>
    </form>
  );
}

// ── Una routine ───────────────────────────────────────────────────────────

function Runs({ id }: { id: string }) {
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  useEffect(() => { void api.routineRuns(id).then((r) => setRuns(r.runs)).catch(() => setRuns([])); }, [id]);
  if (!runs) return <div className="text-[12.5px] text-muted">Carico…</div>;
  if (!runs.length) return <div className="text-[12.5px] text-muted">Nessuna esecuzione ancora.</div>;
  return (
    <div className="flex flex-col">
      {runs.map((x) => (
        <div key={x.id} className="grid grid-cols-[auto_1fr] gap-x-3 border-t border-line/50 py-1.5 text-[12.5px] first:border-t-0">
          <span className="font-mono text-muted">{when(x.ts)}</span>
          <span className="min-w-0">
            <span className={STATUS[x.status].cls}>{STATUS[x.status].label}</span>
            {x.manual && <span className="text-muted"> · a mano</span>}
            {x.durationMs != null && <span className="text-muted"> · {Math.round(x.durationMs / 1000)} s</span>}
            {x.tokensIn != null && <span className="text-muted"> · {tokens(x.tokensIn)} letti, {tokens(x.tokensOut ?? 0)} scritti</span>}
            {x.costUsd != null && <span className="text-muted"> · ≈ {x.costUsd.toFixed(2)} $</span>}
            {x.usageBefore != null && x.usageAfter != null && <span className="text-muted"> · 5 ore {Math.round(x.usageBefore * 100)}→{Math.round(x.usageAfter * 100)}%</span>}
            {x.note && <span className="cc-wrap block text-muted">{x.note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function RoutineItem(props: { r: RoutineView; agents: AgentView[]; showProject: boolean; onOpenChat?: (agentId: string, chatId: string) => void }) {
  const { r } = props;
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [msg, setMsg] = useState('');
  const project = props.agents.find((a) => a.id === r.agentId)?.name ?? r.agentId;
  const act = (p: Promise<unknown>) => void p.catch((e: Error) => setMsg(e.message));
  const launch = () => act(api.runRoutine(r.id).then((x) => setMsg(x.result === 'waiting' ? 'La precedente è ancora al lavoro: parte appena finisce.' : x.result === 'queued' ? 'In coda: parte appena la chat si libera.' : x.result === 'skipped' ? 'Saltata: guarda lo storico.' : 'Partita.')));
  const lastChat = r.last?.chatId;

  return (
    <div className={`flex flex-col gap-2 border-t border-line/60 py-3 first:border-t-0 first:pt-0 ${r.enabled ? '' : 'opacity-60'}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-[14px] font-medium">
            <span className="truncate">⏱ {r.name}</span>
            {r.active && <span className="rounded-[4px] bg-acid/15 px-1.5 py-px font-mono text-[11px] text-acid">al lavoro</span>}
            {r.waiting && <span className="rounded-[4px] bg-wait/15 px-1.5 py-px font-mono text-[11px] text-wait">la prossima aspetta</span>}
            {!r.enabled && <span className="rounded-[4px] bg-line px-1.5 py-px font-mono text-[11px] text-muted">in pausa</span>}
          </span>
          <span className="text-[12.5px] text-muted">
            {props.showProject && <>{project} · </>}{r.when}{r.chatTitle ? ` · in «${r.chatTitle}»` : ` · chat nuova ogni volta${r.permission ? `, livello ${PERMISSION_LEVELS.find((l) => l.key === r.permission)?.label ?? r.permission}` : ''}`}
            {r.createdBy !== 'utente' && ` · creata ${r.createdBy === 'ciccio' ? 'da Ciccio' : "dall'agente"}`}
          </span>
        </div>
        <div className="flex flex-none flex-wrap gap-1.5">
          <button type="button" onClick={launch} className={button}>Lancia ora</button>
          <button type="button" onClick={() => act(api.updateRoutine(r.id, { enabled: !r.enabled }))} className={button}>{r.enabled ? 'Pausa' : 'Riprendi'}</button>
          <button type="button" onClick={() => setEditing(!editing)} className={button}>Modifica</button>
          <button type="button" onClick={() => { if (confirm(`Togliere la routine «${r.name}»? Lo storico delle esecuzioni va via con lei; le chat restano.`)) act(api.removeRoutine(r.id)); }}
            className={`${button} hover:border-block/50 hover:text-block`}>Elimina</button>
        </div>
      </div>
      <div className="cc-wrap line-clamp-2 text-[13px] leading-snug text-soft" title={r.text}>{r.text}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
        <span>prossima: {r.nextRun ? when(r.nextRun) : '—'}</span>
        <span>
          ultima: {r.last ? <><span className={STATUS[r.last.status].cls}>{STATUS[r.last.status].label}</span> {timeAgo(r.last.ts)} fa</> : 'mai'}
          {lastChat && props.onOpenChat && <> · <button type="button" onClick={() => props.onOpenChat!(r.agentId, lastChat)} className="text-acid hover:underline">apri la chat</button></>}
        </span>
        <span>{r.total} esecuzion{r.total === 1 ? 'e' : 'i'} in tutto</span>
      </div>
      <div className="text-[12.5px] text-muted">7 giorni: {usageLine(r.week)} · 30 giorni: {usageLine(r.month)}</div>
      {r.last?.status === 'saltata' && r.last.note && <div className="text-[12.5px] text-wait">{r.last.note}</div>}
      {msg && <div className="text-[12.5px] text-soft">{msg}</div>}
      <button type="button" onClick={() => setHistory(!history)} aria-expanded={history} className="self-start text-[12.5px] text-muted hover:text-text">{history ? 'Nascondi lo storico' : 'Storico delle esecuzioni'}</button>
      <AnimatePresence initial={false}>
        {history && <motion.div key="h" {...collapse} className="overflow-hidden"><Runs id={r.id} /></motion.div>}
        {editing && <motion.div key="e" {...collapse} className="overflow-hidden"><RoutineForm agents={props.agents} routine={r} onDone={() => setEditing(false)} /></motion.div>}
      </AnimatePresence>
    </div>
  );
}

/** Elenco con «Nuova routine»; con agentId solo le routine di quel progetto. */
export function RoutinesSection(props: { agents: AgentView[]; agentId?: string; onOpenChat?: (agentId: string, chatId: string) => void }) {
  const list = useRoutines(props.agentId);
  const [creating, setCreating] = useState(false);
  const sorted = useMemo(() => [...(list ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity)), [list]);
  return (
    <div className="flex flex-col gap-3">
      {list && !list.length && !creating && <div className="text-[13px] text-muted">Nessuna routine{props.agentId ? ' per questo progetto' : ''}.</div>}
      {sorted.length > 0 && <div className="flex flex-col">{sorted.map((r) => <RoutineItem key={r.id} r={r} agents={props.agents} showProject={!props.agentId} onOpenChat={props.onOpenChat} />)}</div>}
      <AnimatePresence initial={false}>
        {creating && <motion.div key="new" {...collapse} className="overflow-hidden"><RoutineForm agents={props.agents} agentId={props.agentId} onDone={() => setCreating(false)} /></motion.div>}
      </AnimatePresence>
      {!creating && <button type="button" onClick={() => setCreating(true)} className="cc-press self-start rounded-[10px] bg-acid px-3.5 py-2 text-[13px] font-semibold text-ink">+ Nuova routine</button>}
    </div>
  );
}
