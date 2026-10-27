// Consumi di token: Ciccio contro Claude Code sul PC dell'utente, con lo stesso metro sui due lati.
//
// I transcript di Claude Code (~/.claude/projects/**/*.jsonl) si riassumono in secchi per giorno (fuso di Ciccio)
// e progetto: sul server li legge Ciccio, sul PC il companion, che manda a Ciccio solo questi secchi (niente testi).
// Qui ci sono i tipi e i conti, uguali per server, companion e pagina.
//
// Token pesati W = (input + 1,25 × cache write 5m + 2 × cache write 1h + 0,1 × cache read + 5 × output) × peso del modello.

import { timeZone, zoneVersion } from './tz.js';

/** Un giorno di un progetto. Le chiamate sono uniche (message.id + requestId), i prompt pure (uuid). */
export interface UsageBucket {
  /** Prompt scritti da una persona (niente risultati di strumenti, comandi locali, promemoria di sistema). */
  prompts: number;
  /** Di questi, quelli partiti in automatico (routine, Ciccio, riprese dopo un riavvio, servizi): solo su Ciccio. */
  promptsAuto: number;
  calls: number;
  callsAuto: number;
  /** Tempo di lavoro dell'agente: pause tra eventi della stessa sessione fino a 5 minuti, sub-agent esclusi. */
  activeMs: number;
  input: number;
  cw5: number;
  cw1h: number;
  cr: number;
  out: number;
  /** Token pesati, con il peso del modello. */
  w: number;
  wAuto: number;
  models: Record<string, { calls: number; w: number }>;
}

/** Secchi per `giorno\tprogetto` (giorno AAAA-MM-GG, fuso di Ciccio). */
export type UsageBuckets = Record<string, UsageBucket>;

export const IDLE_GAP_MS = 5 * 60_000;
/** Giorni tenuti: la pagina ne mostra 30. */
export const KEEP_DAYS = 35;

// Prezzo dell'input per milione di token, dalla skill claude-api (listino del 06/10/2026): il peso è il rapporto
// con Claude Opus 5.5. Output e cache hanno gli stessi rapporti tra modelli (l'output costa 5 volte l'input ovunque).
const INPUT_PRICE: [RegExp, number][] = [
  [/^opus-5-5/, 4], [/^opus-5\b/, 5], [/^opus-4-[678]/, 5], [/^opus/, 4],
  [/^sonnet-5-5/, 2], [/^sonnet-5\b/, 2], [/^sonnet-4-6/, 3], [/^sonnet/, 2],
  [/^haiku-5-5/, 0.1], [/^haiku-4-5/, 1], [/^haiku/, 0.1],
  [/^(fable|mythos)/, 10],
];
const OPUS_PRICE = 4;

/** Nome breve del modello: claude-opus-5-5-20260401 → opus-5-5. */
export const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[1m\]$/, '');

/** Peso del modello rispetto a Claude Opus 5.5 (Sonnet 5.5 = 0,5, Haiku 5.5 = 0,025, Opus 5 = 1,25). */
export function modelWeight(model: string): number {
  const m = shortModel(model);
  for (const [re, price] of INPUT_PRICE) if (re.test(m)) return price / OPUS_PRICE;
  return 1;
}

export interface CallTokens { input: number; cw5: number; cw1h: number; cr: number; out: number }

/** Token pesati di una chiamata, senza il peso del modello. */
export const rawW = (t: CallTokens) => t.input + 1.25 * t.cw5 + 2 * t.cw1h + 0.1 * t.cr + 5 * t.out;

export const emptyBucket = (): UsageBucket => ({ prompts: 0, promptsAuto: 0, calls: 0, callsAuto: 0, activeMs: 0, input: 0, cw5: 0, cw1h: 0, cr: 0, out: 0, w: 0, wAuto: 0, models: {} });

export function addBucket(into: UsageBucket, b: UsageBucket) {
  into.prompts += b.prompts; into.promptsAuto += b.promptsAuto; into.calls += b.calls; into.callsAuto += b.callsAuto;
  into.activeMs += b.activeMs; into.input += b.input; into.cw5 += b.cw5; into.cw1h += b.cw1h; into.cr += b.cr; into.out += b.out;
  into.w += b.w; into.wAuto += b.wAuto;
  for (const [m, v] of Object.entries(b.models)) {
    const x = (into.models[m] ??= { calls: 0, w: 0 });
    x.calls += v.calls; x.w += v.w;
  }
}

/** Unisce più raccolte di secchi (es. più PC). */
export function mergeBuckets(list: UsageBuckets[]): UsageBuckets {
  const out: UsageBuckets = {};
  for (const l of list) for (const [k, b] of Object.entries(l)) addBucket((out[k] ??= emptyBucket()), b);
  return out;
}

export const bucketKey = (day: string, project: string) => `${day}\t${project}`;
export const splitKey = (k: string) => { const i = k.indexOf('\t'); return { day: k.slice(0, i), project: k.slice(i + 1) }; };

let days: { v: number; f: Intl.DateTimeFormat; cache: Map<number, string> } | null = null;
/** Giorno (fuso di Ciccio) di un istante: si calcola una volta per quarto d'ora (anche i fusi con la mezz'ora). */
export function zoneDay(t: number): string {
  if (days?.v !== zoneVersion()) days = { v: zoneVersion(), f: new Intl.DateTimeFormat('sv-SE', { timeZone: timeZone() }), cache: new Map() };
  const q = Math.floor(t / 900_000);
  let d = days.cache.get(q);
  if (!d) { d = days.f.format(new Date(q * 900_000)); days.cache.set(q, d); }
  return d;
}

/** Gli ultimi n giorni (fuso di Ciccio), da oggi indietro. */
export function lastDays(n: number, now = Date.now()): string[] {
  const out: string[] = [];
  for (let t = now; out.length < n; t -= 86_400_000) {
    const d = zoneDay(t);
    if (out[out.length - 1] !== d) out.push(d);
  }
  return out;
}

// ── Indicatori ──────────────────────────────────────────────────────────

export interface UsageStats {
  prompts: number;
  promptsOwner: number;
  calls: number;
  hours: number;
  w: number;
  /** Token pesati senza il peso del modello (per confrontarli con una misura fatta a mano). */
  wRaw: number;
  /** Indicatore principale: token pesati per ora di lavoro dell'agente. */
  wPerHour: number | null;
  wRawPerHour: number | null;
  wPerPrompt: number | null;
  wPerPromptOwner: number | null;
  wPerPromptAuto: number | null;
  callsPerPrompt: number | null;
  /** Contesto medio per chiamata: input + cache write + cache read. */
  ctxPerCall: number | null;
  /** Quota del contesto riscritta in cache (0–1): obiettivo sotto il 2%. */
  cacheRewrite: number | null;
  models: { model: string; w: number; share: number }[];
}

const div = (a: number, b: number) => (b > 0 ? a / b : null);

export function stats(buckets: UsageBucket[]): UsageStats {
  const t = emptyBucket();
  for (const b of buckets) addBucket(t, b);
  const ctx = t.input + t.cw5 + t.cw1h + t.cr;
  const hours = t.activeMs / 3_600_000;
  const wRaw = rawW(t);
  const promptsOwner = t.prompts - t.promptsAuto;
  return {
    prompts: t.prompts, promptsOwner, calls: t.calls, hours, w: t.w, wRaw,
    wPerHour: div(t.w, hours), wRawPerHour: div(wRaw, hours),
    wPerPrompt: div(t.w, t.prompts), wPerPromptOwner: div(t.w - t.wAuto, promptsOwner), wPerPromptAuto: div(t.wAuto, t.promptsAuto),
    callsPerPrompt: div(t.calls, t.prompts), ctxPerCall: div(ctx, t.calls), cacheRewrite: div(t.cw5 + t.cw1h, ctx),
    models: Object.entries(t.models).map(([model, v]) => ({ model, w: v.w, share: t.w ? v.w / t.w : 0 })).sort((a, b) => b.w - a.w),
  };
}

/** Secchi dei giorni indicati, eventualmente di un progetto solo. */
export function pick(all: UsageBuckets, days: string[], project?: string): UsageBucket[] {
  const set = new Set(days);
  return Object.entries(all).filter(([k]) => { const s = splitKey(k); return set.has(s.day) && (project == null || s.project === project); }).map(([, b]) => b);
}

// ── API ─────────────────────────────────────────────────────────────────

export interface ConsumiPc { id: string; name: string; at: number; version: string | null }

export interface ConsumiReport {
  /** Secchi di Ciccio (transcript del server). */
  ciccio: UsageBuckets;
  /** Secchi dei PC con il companion, uniti. */
  pc: UsageBuckets;
  pcs: ConsumiPc[];
  updatedAt: number | null;
  /** Prima lettura dei transcript ancora in corso. */
  scanning: boolean;
}

// ── Companion → Ciccio ──────────────────────────────────────────────────
// companion/usage { buckets, at }: i secchi degli ultimi KEEP_DAYS giorni, all'avvio e poi ogni ora.
export const USAGE_METHOD = 'companion/usage';
export interface UsageParams { buckets: UsageBuckets; at: number }
