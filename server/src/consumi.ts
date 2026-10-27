import os from 'node:os';
import path from 'node:path';
import { config, OWNER } from './config.js';
import { deviceStore, store, turnStore } from './db.js';
import { TranscriptScanner, type Origin } from '../../shared/node/transcripts.js';
import { KEEP_DAYS, lastDays, mergeBuckets, splitKey, type ConsumiReport, type UsageBuckets, type UsageParams } from '../../shared/consumi.js';

// Impostazioni › Consumi: token di Ciccio (transcript di Claude Code sul server, dove girano tutti gli agenti)
// contro quelli di Claude Code sul PC dell'utente (secchi mandati dal companion), con lo stesso metro.
// Chi ha mandato ogni prompt lo sa il server: ogni giro si registra con la sua origine (noteTurn).

/** Chi ha fatto partire un giro: l'utente, Ciccio (orchestratore), una routine, la ripresa dopo un riavvio. */
export type TurnOrigin = 'utente' | 'ciccio' | 'routine' | 'ripresa';

export const turnOrigin = (from: string, routine?: unknown): TurnOrigin => (routine ? 'routine' : from === 'ciccio' ? 'ciccio' : 'utente');

/** Registra l'origine di un giro appena partito (alla prima risposta dell'SDK, quando si conosce la sessione). */
export function noteTurn(sessionId: string, startedAt: number, origin: TurnOrigin) {
  try { turnStore.add(sessionId, startedAt, origin); } catch (err) { console.error('Origine del giro non registrata:', err); }
}

const REFRESH_MS = 10 * 60_000;
const FRESH_MS = 2 * 60_000;

/** Nome del progetto di una cartella dei transcript (il percorso con i caratteri non alfanumerici diventati «-»). */
function projectOf(dir: string): string {
  const enc = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
  if (dir === enc(config.projectsDir)) return 'Ciccio';
  if (dir === enc(config.dataDir) || dir.startsWith(`${enc(config.dataDir)}-`)) return 'Ciccio · servizi';
  // Worktree delle chat (<repo>/.ciccio/worktrees/<id>) insieme al loro progetto: vince il percorso più lungo.
  let best: { len: number; name: string } | null = null;
  for (const a of store.agents()) {
    const e = enc(a.path);
    if ((dir === e || dir.startsWith(`${e}-`)) && (!best || e.length > best.len)) best = { len: e.length, name: a.display_name?.trim() || a.id };
  }
  return best?.name ?? (dir.replace(new RegExp(`^${enc(os.homedir())}-+`), '').replace(/^-+/, '') || dir);
}

// ── Origine dei prompt ──────────────────────────────────────────────────

let turns = new Map<string, { ts: number; origin: string }[]>();
let logStart: number | null = null;
let sent: { ts: number; text: string; owner: boolean }[] = [];
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Si rilegge prima di ogni lettura dei transcript: registro dei giri e, per i giri di prima, i messaggi mandati. */
function loadOrigins() {
  const since = Date.now() - (KEEP_DAYS + 1) * 86_400_000;
  turnStore.prune(since - 5 * 86_400_000);
  turns = new Map();
  for (const r of turnStore.since(since)) {
    const l = turns.get(r.session_id);
    if (l) l.push(r); else turns.set(r.session_id, [r]);
  }
  logStart = turnStore.first();
  sent = logStart != null && logStart < since ? [] : turnStore.sentSince(since).map((m) => {
    const meta = m.meta ? (JSON.parse(m.meta) as { routine?: string }) : null;
    return { ts: m.ts, text: norm(m.text), owner: m.role === 'user' && !meta?.routine };
  }).filter((m) => m.text);
}

function originOf(p: { sessionId: string; ts: number; text: string }): Origin {
  // Il giro parte un attimo prima che il prompt arrivi nel transcript: vale l'ultimo partito entro 5 secondi dopo.
  const list = turns.get(p.sessionId);
  if (list) {
    let hit: string | null = null;
    for (const t of list) if (t.ts <= p.ts + 5_000) hit = t.origin;
    if (hit) return hit === 'utente' ? 'utente' : 'auto';
  }
  // Dopo l'inizio del registro, un prompt senza giro registrato è un servizio (titoli, riassunti, riepilogo).
  if (logStart != null && p.ts >= logStart) return 'auto';
  // Prima del registro: il messaggio salvato nella chat con lo stesso testo (l'utente, Ciccio o una routine).
  // Il prompt può avere davanti note di Ciccio e dietro gli allegati: si guarda la fine, o il testo intero se è lungo.
  const text = norm(p.text);
  let best: { ts: number; owner: boolean } | null = null;
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i];
    if (m.ts > p.ts + 60_000) continue;
    if (m.ts < p.ts - 6 * 3_600_000) break;
    if (text.endsWith(m.text) || text.includes(`${m.text} Allegati di ${OWNER}`) || (m.text.length >= 40 && text.includes(m.text))) { best = m; break; }
  }
  return best?.owner ? 'utente' : 'auto';
}

// ── Lettura dei transcript ──────────────────────────────────────────────

const scanner = new TranscriptScanner({
  root: path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects'),
  cacheFile: path.join(config.dataDir, 'consumi-cache.json'),
  project: projectOf,
  origin: originOf,
  holdMs: 60_000,
});

function refresh(): Promise<void> {
  loadOrigins();
  return scanner.refresh().catch((err) => console.error('Lettura dei consumi non riuscita:', err));
}

/** Prima lettura a server avviato (in sottofondo), poi ogni 10 minuti. */
export function startConsumi() {
  setTimeout(() => void refresh(), 20_000).unref();
  setInterval(() => void refresh(), REFRESH_MS).unref();
}

// ── PC (companion) ──────────────────────────────────────────────────────

type PcStore = Record<string, { at: number; buckets: UsageBuckets }>;

/** Secchi mandati dal companion di un PC: si tengono solo gli ultimi giorni e i campi numerici. */
export function savePcUsage(deviceId: string, params: unknown) {
  const p = params as Partial<UsageParams> | undefined;
  if (!p || typeof p.buckets !== 'object' || !p.buckets) return;
  const days = new Set(lastDays(KEEP_DAYS + 1));
  const clean: UsageBuckets = {};
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  for (const [k, b] of Object.entries(p.buckets).slice(0, 5000)) {
    const { day, project } = splitKey(k);
    if (!days.has(day) || !project || !b || typeof b !== 'object') continue;
    const models: Record<string, { calls: number; w: number }> = {};
    for (const [m, v] of Object.entries((b.models ?? {}) as Record<string, { calls?: unknown; w?: unknown }>).slice(0, 30)) models[m.slice(0, 40)] = { calls: n(v?.calls), w: n(v?.w) };
    clean[`${day}\t${project.slice(0, 80)}`] = {
      prompts: n(b.prompts), promptsAuto: 0, calls: n(b.calls), callsAuto: 0, activeMs: n(b.activeMs),
      input: n(b.input), cw5: n(b.cw5), cw1h: n(b.cw1h), cr: n(b.cr), out: n(b.out), w: n(b.w), wAuto: 0, models,
    };
  }
  const all = store.getKv<PcStore>('consumi_pc') ?? {};
  all[deviceId] = { at: Date.now(), buckets: clean };
  store.setKv('consumi_pc', all);
}

// ── API ─────────────────────────────────────────────────────────────────

/** Ultimi 31 giorni dei due lati. Se i dati di Ciccio hanno più di 2 minuti, prima si leggono le righe nuove. */
export async function consumiReport(): Promise<ConsumiReport> {
  if (!scanner.scanning && (scanner.updatedAt == null || Date.now() - scanner.updatedAt > FRESH_MS)) await refresh();
  const days = new Set(lastDays(31));
  const recent = (b: UsageBuckets) => Object.fromEntries(Object.entries(b).filter(([k]) => days.has(splitKey(k).day)));
  const devices = new Map(deviceStore.all().map((d) => [d.id, d]));
  const pcData = Object.entries(store.getKv<PcStore>('consumi_pc') ?? {}).filter(([id]) => devices.has(id));
  return {
    ciccio: recent(scanner.buckets()),
    pc: recent(mergeBuckets(pcData.map(([, v]) => v.buckets))),
    pcs: pcData.map(([id, v]) => ({ id, name: devices.get(id)!.name, at: v.at, version: devices.get(id)!.version })),
    updatedAt: scanner.updatedAt,
    scanning: scanner.scanning,
  };
}
