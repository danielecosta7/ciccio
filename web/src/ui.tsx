import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { AnimatePresence, motion } from 'motion/react';
import { quick } from './motion';
import type { AgentStatus, CiccioPhase, RecapTone, UsageState } from '../../shared/types';

export const STATUS: Record<AgentStatus, { label: string; color: string; bg: string }> = {
  wait: { label: 'Ti aspetta', color: '#FFB224', bg: 'rgb(255 178 36 / .13)' },
  block: { label: 'Bloccato', color: '#FF6A55', bg: 'rgb(255 106 85 / .13)' },
  work: { label: 'Al lavoro', color: '#A6FF00', bg: 'rgb(166 255 0 / .11)' },
  stale: { label: 'Fermo', color: 'oklch(0.66 0 0)', bg: 'oklch(1 0 0 / .05)' },
  idle: { label: 'In ordine', color: 'oklch(0.78 0 0)', bg: 'oklch(1 0 0 / .07)' },
};

/** Contorno in movimento per chat e agenti: arancio che lampeggia se aspettano l'utente, verde se lavorano, niente se fermi. */
export const runRing = (status: AgentStatus) => (status === 'wait' ? 'cc-run cc-run-wait' : status === 'work' ? 'cc-run cc-run-acid' : '');

export const TONE_COLOR: Record<RecapTone, string> = {
  wait: '#FFB224', block: '#FF6A55', done: '#3DD68C', stale: 'oklch(0.66 0 0)', work: '#A6FF00', info: 'oklch(0.72 0 0)',
};

/** Fase di Ciccio → stato dell'orb (D5). */
export type VoicePhase = CiccioPhase | 'listening';
export const PHASE_ORB: Record<VoicePhase, OrbState> = {
  idle: 'breathing',
  listening: 'listening',
  thinking: 'solving',
  connecting: 'connecting',
  speaking: 'weaving',
};

/** Orb alle sole dimensioni native della libreria: ingrandirlo lo renderebbe sfocato. */
export function Orb({ state, size = 64, label }: { state: OrbState; size?: 64 | 32 | 20; label?: string }) {
  return (
    <ThinkingOrb
      state={state}
      size={size}
      theme="dark"
      color="#A6FF00"
      aria-label={label ?? `Ciccio: ${state}`}
    />
  );
}

export function StatusPill({ status }: { status: AgentStatus }) {
  const s = STATUS[status];
  return (
    // Chiave sullo stato: quando cambia, la vecchia pastiglia esce e la nuova entra con una breve dissolvenza.
    <AnimatePresence mode="popLayout" initial={false}>
    <motion.span
      key={status}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1, transition: quick }}
      exit={{ opacity: 0, scale: 0.9, transition: quick }}
      className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-[4px] px-2 py-0.5 text-[12px] font-medium"
      style={{ background: s.bg, color: s.color }}
    >
      {status === 'work'
        ? <span className="-my-1 -ml-1 inline-flex"><ThinkingOrb state="working" size={20} theme="dark" color="#A6FF00" aria-hidden="true" /></span>
        : <span className={status === 'wait' ? 'cc-sq-pulse' : ''} style={{ width: 7, height: 7, background: s.color }} />}
      {s.label}
    </motion.span>
    </AnimatePresence>
  );
}

/** Segnaposto pixel di Ciccio finché non arriva l'avatar: griglia 8×8, sempre a multipli interi. */
export function PixelMark({ size = 40 }: { size?: 16 | 32 | 40 | 48 }) {
  return (
    // Il logo di Ciccio, come web/public/favicon.svg (disegnato in Affinity sulla griglia 8x8).
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true" className="flex-none">
      <rect width="8" height="8" fill="#A6FF00" />
      <path fill="#070707" d="M2 2h4v1H3v2h3v1H2z" />
    </svg>
  );
}

// La scritta «CICCIO» in pixel, disegnata in Affinity sulla griglia del font Silkscreen (28x5).
// Come SVG resta netta ovunque, anche dove il browser sfuma il testo del font (Chrome su Windows).
const WORDMARK = 'M1 0h2v1h-2zM6 0h1v1h-1zM10 0h2v1h-2zM16 0h2v1h-2zM21 0h1v1h-1zM25 0h2v1h-2zM0 1h1v1h-1zM3 1h1v1h-1zM6 1h1v1h-1zM9 1h1v1h-1zM12 1h1v1h-1zM15 1h1v1h-1zM18 1h1v1h-1zM21 1h1v1h-1zM24 1h1v1h-1zM27 1h1v1h-1zM0 2h1v1h-1zM6 2h1v1h-1zM9 2h1v1h-1zM15 2h1v1h-1zM21 2h1v1h-1zM24 2h1v1h-1zM27 2h1v1h-1zM0 3h1v1h-1zM3 3h1v1h-1zM6 3h1v1h-1zM9 3h1v1h-1zM12 3h1v1h-1zM15 3h1v1h-1zM18 3h1v1h-1zM21 3h1v1h-1zM24 3h1v1h-1zM27 3h1v1h-1zM1 4h2v1h-2zM6 4h1v1h-1zM10 4h2v1h-2zM16 4h2v1h-2zM21 4h1v1h-1zM25 4h2v1h-2z';

/** «CICCIO»: scale 2 al posto del testo pixel-16, 3 al posto di pixel-24. Prende il colore del testo. */
export function PixelWordmark({ scale = 2, className = '' }: { scale?: 2 | 3; className?: string }) {
  return (
    <svg width={28 * scale} height={5 * scale} viewBox="0 0 28 5" shapeRendering="crispEdges" fill="currentColor" role="img" aria-label="Ciccio" className={`flex-none ${className}`}>
      <path d={WORDMARK} />
    </svg>
  );
}

/** Ingranaggio delle Impostazioni: lo stesso in dashboard e nella chat. */
export function SettingsIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>
  );
}

export function MicIcon({ size = 18, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2.5" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3.5" />
    </svg>
  );
}

export function SendIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function resetIn(ms: number, weekly: boolean): string {
  const diff = ms - Date.now();
  if (diff <= 0) return 'si sta azzerando';
  if (weekly && diff > 24 * 3_600_000) {
    return `si azzera ${new Intl.DateTimeFormat('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))}`;
  }
  const h = Math.floor(diff / 3_600_000), m = Math.round((diff % 3_600_000) / 60_000);
  return `si azzera tra ${h ? `${h} h ` : ''}${m} min`;
}

/** Colore di un livello in percentuale: verde acido, arancio da 80, rosso da 95 (come l'uso di Claude). */
export const levelColor = (pct: number | null) => (pct == null ? 'oklch(0.4 0 0)' : pct >= 95 ? '#FF6A55' : pct >= 80 ? '#FFB224' : '#A6FF00');
const EMPTY = 'oklch(0.27 0 0)';

/** Barra a 10 quadratini per una percentuale (null = dato che manca). */
export function PixelBar({ pct }: { pct: number | null }) {
  const filled = pct == null ? 0 : Math.min(10, Math.ceil(pct / 10));
  const color = levelColor(pct);
  return (
    <span className="inline-flex flex-none gap-[2px]" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => <span key={i} style={{ width: 4, height: 10, background: i < filled ? color : EMPTY }} />)}
    </span>
  );
}

/**
 * Andamento nel tempo con la stessa grafica a quadratini: una colonna per campione, alta fino a 8 quadratini,
 * colorata con lo stesso criterio della barra. `values` in percentuale (0–100), dal più vecchio.
 */
export function PixelHistory({ values, label, slots = 60 }: { values: number[]; label: string; slots?: number }) {
  // Più campioni che colonne: si prende il massimo di ogni gruppo, così un picco non sparisce.
  const step = Math.max(1, Math.ceil(values.length / slots));
  const cols: number[] = [];
  for (let i = 0; i < values.length; i += step) cols.push(Math.max(...values.slice(i, i + step)));
  const pad = Math.max(0, slots - cols.length);
  return (
    <div role="img" aria-label={label} className="flex h-[38px] w-full items-end gap-[2px]">
      {/* Minuti senza dati (server appena riavviato): colonne vuote, così la larghezza è sempre quella del periodo. */}
      {Array.from({ length: pad }, (_, i) => (
        <span key={`v${i}`} className="flex min-w-0 flex-1 flex-col-reverse gap-[2px]">
          {Array.from({ length: 8 }, (_, j) => <span key={j} style={{ height: 3, background: EMPTY }} />)}
        </span>
      ))}
      {cols.map((v, i) => {
        const cells = v <= 0 ? 0 : Math.max(1, Math.min(8, Math.round((v / 100) * 8)));
        return (
          <span key={i} className="flex min-w-0 flex-1 flex-col-reverse gap-[2px]">
            {Array.from({ length: 8 }, (_, j) => <span key={j} style={{ height: 3, background: j < cells ? levelColor(v) : EMPTY }} />)}
          </span>
        );
      })}
    </div>
  );
}

/** Uso dell'abbonamento Claude in una finestra: barra a 10 quadratini, percentuale e ripristino. */
export function UsageMeter({ label, w, weekly = false, compact = false }: { label: string; w: { utilization: number; resetsAt: number } | null; weekly?: boolean; compact?: boolean }) {
  const pct = w ? Math.round(w.utilization * 100) : null;
  const color = levelColor(pct);
  // Telefono: solo etichetta breve e percentuale; il resto nel suggerimento.
  if (compact) return (
    <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-2.5 font-mono text-[12px]"
      title={w ? `${label}: ${pct}% usato, ${resetIn(w.resetsAt, weekly)}` : `${label}: dato non ancora disponibile`}>
      <span className="text-muted">{weekly ? '7g' : '5h'}</span>
      <span className="font-medium" style={{ color: pct == null ? undefined : color }}>{pct == null ? '–' : `${pct}%`}</span>
    </span>
  );
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-[13px]"
      title={w ? `${label}: ${pct}% usato, ${resetIn(w.resetsAt, weekly)}` : `${label}: dato non ancora disponibile`}>
      <span className="text-muted">{label}</span>
      <PixelBar pct={pct} />
      <span className="font-mono text-[12px] font-medium" style={{ color: pct == null ? undefined : color }}>{pct == null ? '–' : `${pct}%`}</span>
      {w && <span className="hidden text-[12px] text-muted md:inline">{resetIn(w.resetsAt, weekly)}</span>}
    </span>
  );
}

/** Uso dell'abbonamento Claude: finestre di 5 ore e settimana; niente finché non si sa. */
export function ClaudeUsage({ state, compact = false }: { state: UsageState | null; compact?: boolean }) {
  if (!state || state.auth === 'none') return null;
  if (compact) return <UsageMeter compact label="5 ore" w={state.usage?.fiveHour ?? null} />;
  return (
    <>
      <UsageMeter label="5 ore" w={state.usage?.fiveHour ?? null} />
      <UsageMeter label="Settimana" w={state.usage?.sevenDay ?? null} weekly />
    </>
  );
}

/** Nome leggibile di uno strumento: mcp__claude_ai_Linear__list_issues → «Linear · list issues». */
/** Permessi che dai solo tu, ogni volta: chiavi SSH, segreti di 1Password e programmi di sistema (niente «sempre»). */
export const onlyOnce = (tool: string) => tool === 'SSH' || tool === 'mcp__ciccio_credenziali__usa_credenziale' || tool === 'mcp__ciccio_sistema__installa_programma' || tool === 'mcp__ciccio_sistema__installa_da_url' || tool === 'mcp__ciccio_sistema__consenti_dominio' || tool === 'mcp__ciccio_strumenti__crea_routine';
/** Proposte di strumenti nuovi per il progetto: solo «Consenti sempre» (lo salva) o «Rifiuta». */
export const alwaysOnly = (tool: string) => tool === 'mcp__ciccio_strumenti__proponi_comando' || tool === 'mcp__ciccio_strumenti__proponi_server_mcp';

export function toolLabel(tool: string): string {
  if (tool === 'SSH') return 'Chiavi SSH di 1Password';
  if (tool === 'mcp__ciccio_credenziali__usa_credenziale') return 'Segreto di 1Password';
  if (tool === 'mcp__ciccio_sistema__installa_programma') return 'Programma di sistema';
  if (tool === 'mcp__ciccio_sistema__installa_da_url') return 'Programma scaricato da internet';
  if (tool === 'mcp__ciccio_sistema__consenti_dominio') return 'Dominio nuovo nel proxy';
  if (tool === 'mcp__ciccio_strumenti__proponi_comando') return 'Strumento nuovo per il progetto';
  if (tool === 'mcp__ciccio_strumenti__proponi_server_mcp') return 'Server MCP nuovo per il progetto';
  if (tool === 'mcp__ciccio_strumenti__crea_routine') return 'Routine nuova';
  const m = tool.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return tool;
  // Strumenti su misura del progetto (ciccio_strumenti) e server MCP aggiunti al progetto (prj_<nome>).
  const server = m[1] === 'ciccio_strumenti' ? 'Strumento del progetto'
    : m[1].replace(/^claude_ai_/, '').replace(/^pc_(\w+)$/, 'PC $1').replace(/^prj_(\w+)$/, 'MCP del progetto $1').replace(/_/g, ' ');
  return `${server === 'ciccio' ? 'Ciccio' : server} · ${m[2].replace(/_/g, ' ')}`;
}

/** Cosa salva «Consenti sempre»: la regola decisa dal server; null = niente «sempre», solo una volta. */
export const alwaysRule = (a: { tool: string; rule?: string | null }): string | null => (onlyOnce(a.tool) || alwaysOnly(a.tool) ? null : a.rule ?? null);

/** La regola come si legge sul pulsante: «Bash:npm test» → «npm test …», gli altri strumenti col nome leggibile. */
export function ruleLabel(rule: string): string {
  const m = /^(Bash|Monitor):(.*)$/.exec(rule);
  return m ? `${m[2]} …` : `${toolLabel(rule)}, ogni volta`;
}

/** Testo del pulsante «sempre», con sotto la regola esatta che salva (intera nel suggerimento). */
export function AlwaysLabel(props: { rule: string; label?: string }) {
  return (
    <span className="flex min-w-0 flex-col items-center leading-tight" title={`Salva nel progetto la regola ${props.rule}: vale per tutte le chat finché non la togli`}>
      <span>{props.label ?? 'Sempre'}</span>
      <span className="max-w-full truncate font-mono text-[10.5px] font-normal opacity-70">{ruleLabel(props.rule)}</span>
    </span>
  );
}

/** Input dello strumento com'è, per «Input completo» nella card (niente per le richieste senza parametri). */
function rawInput(input: unknown): string {
  if (input == null || (typeof input === 'object' && !Object.keys(input).length)) return '';
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
}

/**
 * Dettaglio di un permesso nella card: il testo intero, che scorre se è lungo (niente righe nascoste dietro un
 * motivo lungo), e sotto, a richiesta, l'input completo dello strumento. Un riepilogo tagliato dal server finisce con
 * «… [+N caratteri]»: il resto è nell'input completo.
 */
export function ApprovalDetail(props: { a: { tool: string; summary: string; input?: unknown }; small?: boolean }) {
  const { detail } = approvalParts(props.a);
  const raw = rawInput(props.a.input);
  const size = props.small ? 'text-[11.5px]' : 'text-[12.5px]';
  return (
    <>
      {detail && <code tabIndex={0} className={`cc-wrap block max-h-48 overflow-y-auto overscroll-contain whitespace-pre-wrap rounded-[8px] bg-ink px-2.5 py-2 font-mono leading-snug ${size}`}>{detail}</code>}
      {raw && (
        <details className="text-[12px] text-muted">
          <summary className="cursor-pointer select-none">Input completo</summary>
          <pre className="cc-wrap mt-1.5 max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap rounded-[8px] bg-ink px-2.5 py-2 font-mono text-[11.5px] leading-snug text-text">{raw}</pre>
        </details>
      )}
    </>
  );
}

/** Dettaglio di una richiesta di permesso: senza il nome dello strumento davanti, motivo a parte. */
export function approvalParts(a: { tool: string; summary: string; input?: unknown }): { detail: string; reason: string } {
  const at = a.summary.lastIndexOf(' · ');
  const head = at > 0 ? a.summary.slice(0, at) : a.summary;
  const reason = at > 0 ? a.summary.slice(at + 3) : '';
  // Un comando si mostra intero dall'input: il riepilogo può essere accorciato.
  const command = (a.input as { command?: unknown } | null | undefined)?.command;
  if (typeof command === 'string' && head.startsWith(`${a.tool}: `)) return { detail: command.trim(), reason };
  let detail = (head.startsWith(`${a.tool}: `) ? head.slice(a.tool.length + 2) : head.startsWith(`${a.tool} `) ? head.slice(a.tool.length + 1) : head).trim();
  // Argomenti in JSON (anche troncati): «chiave: valore», uno per riga.
  if (detail.startsWith('{')) {
    detail = detail.replace(/^\{|\}$/g, '').replace(/"([\w-]+)":\s*/g, '\n$1: ').replace(/",\s*\n/g, '\n').replace(/"/g, '').replace(/,\s*\n/g, '\n').trim();
  }
  return { detail, reason };
}
