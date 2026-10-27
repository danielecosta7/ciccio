import { randomBytes } from 'node:crypto';
import { routineStore, store, type RoutineRow, type RoutineRunRow } from './db.js';
import { agentEvents, bus, type RoutineTag } from './bus.js';
import { archiveChat, chatBusy, createChat, sendToChat } from './agents.js';
import { currentUsage } from './usage.js';
import { settings } from './settings.js';
import { config } from './config.js';
import { cronMatches, describeCron, nextRuns, parseCron } from '../../shared/cron.js';
import { PERMISSION_LEVELS, type PermissionLevel, type RoutineRun, type RoutineUsage, type RoutineView } from '../../shared/types.js';

// Routine: un messaggio che Ciccio manda da solo a un progetto, a orari fissi (cron nel fuso config.tz), come se
// lo scrivesse l'utente. Ogni giro di un agente è un processo che si chiude a fine risposta: CronCreate, /loop e
// ScheduleWakeup di Claude Code morirebbero con lui, quindi l'orologio lo tiene il server.
// - Dove: una chat nuova a ogni esecuzione (senza contesto: costa solo il prefisso, che è lo stesso di tutte le
//   chat del progetto), oppure una chat fissa con la sua sessione. Con le chat nuove la precedente si archivia
//   da sola quando parte la successiva, se è ferma (i messaggi restano).
// - Chat occupata: il messaggio va in coda come quelli dell'utente. Se è ancora al lavoro l'esecuzione precedente
//   della stessa routine, la nuova aspetta che finisca (una sola in attesa: niente giri accavallati).
// - Consumo: oltre la soglia delle Impostazioni (finestra di 5 ore) le esecuzioni programmate
//   saltano; «Lancia ora» no, l'ha chiesto l'utente.
//   Ogni esecuzione registra token, costo equivalente API e finestra prima e dopo.
// - L'esito arriva come avviso nella chat di Ciccio, con le stesse regole degli altri giri.

const TICK_MS = 20_000;
const MAX_TEXT = 8000;
const MAX_ROUTINES = 50;

/** Esecuzione al lavoro o in coda, per routine. */
const active = new Map<string, string>();
/** Routine con un'esecuzione che aspetta la fine della precedente (manuale o no). */
const waiting = new Map<string, boolean>();

const newId = (p: string) => `${p}${randomBytes(6).toString('hex')}`;
const minuteOf = (ms: number) => Math.floor(ms / 60_000) * 60_000;

function toRun(r: RoutineRunRow): RoutineRun {
  return {
    id: r.id, routineId: r.routine_id, ts: r.ts, status: r.status, chatId: r.chat_id, note: r.note, durationMs: r.duration_ms,
    tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd, usageBefore: r.usage_before, usageAfter: r.usage_after, manual: !!r.manual,
  };
}

function usage(id: string, days: number): RoutineUsage {
  const u = routineStore.usage(id, Date.now() - days * 86_400_000);
  return { runs: u.runs, tokensIn: u.tokens_in, tokensOut: u.tokens_out, costUsd: u.cost_usd };
}

function view(r: RoutineRow): RoutineView {
  let next: number | null = null;
  try { next = r.enabled ? nextRuns(parseCron(r.cron), Date.now())[0] ?? null : null; } catch { /* cron non valido: niente prossima */ }
  const last = routineStore.runs(r.id, 1)[0];
  const chat = r.chat_id ? store.chat(r.chat_id) : undefined;
  return {
    id: r.id, agentId: r.agent_id, name: r.name, text: r.text, cron: r.cron, when: describeCron(r.cron),
    chatId: r.chat_id, chatTitle: chat?.title ?? null, permission: r.permission, enabled: !!r.enabled, createdBy: r.created_by, createdAt: r.created_at,
    nextRun: next, active: active.has(r.id), waiting: waiting.has(r.id), last: last ? toRun(last) : null,
    total: routineStore.count(r.id), week: usage(r.id, 7), month: usage(r.id, 30),
  };
}

export function routineViews(agentId?: string): RoutineView[] {
  return routineStore.all().filter((r) => !agentId || r.agent_id === agentId).map(view);
}

export function routineRuns(id: string): RoutineRun[] {
  return routineStore.runs(id, 40).map(toRun);
}

function publish() {
  bus.emit({ type: 'routines', routines: routineViews() });
}

/** `permission`: livello delle chat nuove della routine (null = predefinito); lo passa solo l'interfaccia dell'utente. */
export interface RoutineInput { agentId: string; name: string; text: string; cron: string; chatId?: string | null; permission?: PermissionLevel | null }

const isLevel = (v: unknown): v is PermissionLevel => PERMISSION_LEVELS.some((l) => l.key === v);

/** Controlla una routine nuova o cambiata; lancia un errore in italiano se qualcosa non va. */
export function checkRoutine(i: Partial<RoutineInput>, partial = false): void {
  if (!partial || i.agentId !== undefined) {
    if (!i.agentId || !store.agent(i.agentId)) throw new Error(`Progetto sconosciuto: ${i.agentId ?? ''}`);
  }
  if (!partial || i.name !== undefined) {
    if (!i.name?.trim() || i.name.trim().length > 60) throw new Error('Serve un nome breve (al massimo 60 caratteri).');
  }
  if (!partial || i.text !== undefined) {
    if (!i.text?.trim()) throw new Error('Manca il testo da mandare.');
    if (i.text.length > MAX_TEXT) throw new Error(`Testo troppo lungo (al massimo ${MAX_TEXT} caratteri).`);
  }
  if (!partial || i.cron !== undefined) parseCron(i.cron ?? '');
  if (i.permission != null && !isLevel(i.permission)) throw new Error('Livello di autorizzazione non valido.');
  if (i.chatId) {
    const chat = store.chat(i.chatId);
    const agentId = i.agentId ?? undefined;
    if (!chat || (agentId && chat.agent_id !== agentId)) throw new Error('La chat scelta non è di questo progetto.');
  }
}

export function createRoutine(i: RoutineInput, by: RoutineRow['created_by']): RoutineView {
  checkRoutine(i);
  if (routineStore.all().length >= MAX_ROUTINES) throw new Error(`Ci sono già ${MAX_ROUTINES} routine: togline qualcuna prima.`);
  const row = {
    id: newId('r'), agent_id: i.agentId, name: i.name.trim(), text: i.text.trim(), cron: parseCron(i.cron).source,
    chat_id: i.chatId || null, enabled: 1, created_by: by, created_at: Date.now(),
    // Agenti e Ciccio non alzano il livello: le loro routine partono come le chat nuove.
    permission: by === 'utente' && i.permission ? i.permission : null,
  };
  routineStore.add(row);
  publish();
  return view(routineStore.get(row.id)!);
}

/** Cambia una routine (dall'interfaccia dell'utente; Ciccio passa solo `enabled`). */
export function updateRoutine(id: string, patch: Partial<Omit<RoutineInput, 'agentId'>> & { enabled?: boolean }): RoutineView {
  const r = routineStore.get(id);
  if (!r) throw new Error('Routine sconosciuta.');
  checkRoutine({ ...patch, agentId: r.agent_id }, true);
  routineStore.update(id, {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.text !== undefined ? { text: patch.text.trim() } : {}),
    ...(patch.cron !== undefined ? { cron: parseCron(patch.cron).source } : {}),
    ...(patch.chatId !== undefined ? { chat_id: patch.chatId || null } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled ? 1 : 0 } : {}),
    ...(patch.permission !== undefined ? { permission: patch.permission || null } : {}),
  });
  // In pausa: chi aspettava il proprio turno non parte più.
  if (patch.enabled === false) waiting.delete(id);
  publish();
  return view(routineStore.get(id)!);
}

export function removeRoutine(id: string): boolean {
  if (!routineStore.get(id)) return false;
  routineStore.remove(id);
  active.delete(id);
  waiting.delete(id);
  publish();
  return true;
}

/** Cerca una routine per id o nome (anche parziale), eventualmente in un progetto. */
export function findRoutine(ref: string, agentId?: string): RoutineRow | undefined {
  const q = ref.trim().toLowerCase();
  const list = routineStore.all().filter((r) => !agentId || r.agent_id === agentId);
  return list.find((r) => r.id === ref) ?? list.find((r) => r.name.toLowerCase() === q) ?? list.find((r) => r.name.toLowerCase().includes(q));
}

function skip(r: RoutineRow, note: string, manual: boolean) {
  routineStore.addRun({
    id: newId('x'), routine_id: r.id, ts: Date.now(), status: 'saltata', chat_id: null, note, duration_ms: null,
    tokens_in: null, tokens_out: null, cost_usd: null, usage_before: currentUsage()?.fiveHour?.utilization ?? null, usage_after: null, manual: manual ? 1 : 0,
  });
  agentEvents.notice({ agentId: r.agent_id, chatId: r.last_chat_id ?? r.chat_id ?? '', text: `Routine «${r.name}» saltata: ${note}.`, tone: 'block' });
  publish();
}

/**
 * Fa partire una routine adesso: in coda dietro la sua esecuzione precedente, se c'è ancora.
 * `manual` = «Lancia ora» dell'utente (o Ciccio su sua richiesta): non guarda la soglia sull'uso.
 */
export function fireRoutine(id: string, manual: boolean): 'started' | 'queued' | 'waiting' | 'skipped' {
  const r = routineStore.get(id);
  if (!r) throw new Error('Routine sconosciuta.');
  if (!store.agent(r.agent_id)) { skip(r, 'il progetto non c\'è più', manual); return 'skipped'; }
  if (active.has(id)) {
    waiting.set(id, manual || (waiting.get(id) ?? false));
    publish();
    return 'waiting';
  }
  const limit = settings().routineUsageLimit;
  const five = currentUsage()?.fiveHour;
  if (!manual && limit < 100 && five && five.resetsAt > Date.now() && five.utilization * 100 >= limit) {
    skip(r, `la finestra di 5 ore è al ${Math.round(five.utilization * 100)}%, oltre la soglia del ${limit}% (Impostazioni › Routine)`, manual);
    return 'skipped';
  }
  // Chat fissa (se c'è ancora) oppure una chat nuova, e la precedente della routine in archivio se è ferma.
  let chatId = r.chat_id && store.chat(r.chat_id) ? r.chat_id : null;
  if (!chatId) {
    if (r.last_chat_id && store.chat(r.last_chat_id) && !chatBusy(r.last_chat_id)) archiveChat(r.last_chat_id);
    const stamp = new Intl.DateTimeFormat('it-IT', { timeZone: config.tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date());
    chatId = createChat(r.agent_id, `⏱ ${r.name} · ${stamp}`).id;
    // Livello scelto dall'utente per la routine (es. Accetta modifiche, per aggiornare STATUS.md senza fermarsi).
    if (r.permission) store.updateChat(chatId, { permission: r.permission });
  }
  const runId = newId('x');
  routineStore.addRun({
    id: runId, routine_id: r.id, ts: Date.now(), status: 'in_corso', chat_id: chatId, note: null, duration_ms: null,
    tokens_in: null, tokens_out: null, cost_usd: null, usage_before: five?.utilization ?? null, usage_after: null, manual: manual ? 1 : 0,
  });
  routineStore.update(r.id, { last_chat_id: chatId });
  active.set(r.id, runId);
  const tag: RoutineTag = { runId, name: r.name };
  const res = sendToChat(chatId, r.text, 'user', [], tag);
  if (res === 'queued') routineStore.updateRun(runId, { status: 'in_coda' });
  publish();
  return res;
}

/** Fine di un giro mandato da una routine: esito, consumo e, se c'era, la prossima esecuzione in attesa. */
function onFinished(e: Parameters<Parameters<typeof agentEvents.onFinished>[0]>[0]) {
  if (!e.routine) return;
  const run = routineStore.run(e.routine.runId);
  if (!run) return;
  const status = e.aborted ? 'fermata' : e.error ? 'errore' : 'ok';
  routineStore.updateRun(run.id, {
    status, note: e.error ? e.error.split('\n')[0].slice(0, 300) : null,
    duration_ms: e.stats?.durationMs ?? null, tokens_in: e.stats?.tokensIn ?? null, tokens_out: e.stats?.tokensOut ?? null,
    cost_usd: e.stats?.costUsd ?? null, usage_after: currentUsage()?.fiveHour?.utilization ?? null,
  });
  if (active.get(run.routine_id) === run.id) active.delete(run.routine_id);
  const next = waiting.get(run.routine_id);
  if (next !== undefined) {
    waiting.delete(run.routine_id);
    const r = routineStore.get(run.routine_id);
    if (r && (r.enabled || next)) { try { fireRoutine(r.id, next); } catch (err) { console.error('Routine non partita:', err); } }
  }
  publish();
}

/** Ogni 20 secondi: le routine attive il cui cron cade in questo minuto (una volta sola per minuto). */
export function startRoutines() {
  agentEvents.onFinished(onFinished);
  const tick = () => {
    const now = Date.now();
    const minute = minuteOf(now);
    for (const r of routineStore.all()) {
      if (!r.enabled || (r.last_fire ?? 0) >= minute) continue;
      let due = false;
      try { due = cronMatches(parseCron(r.cron), now); } catch { continue; }
      if (!due) continue;
      routineStore.update(r.id, { last_fire: minute });
      try { fireRoutine(r.id, false); } catch (err) { console.error(`Routine ${r.name} non partita:`, err); }
    }
  };
  setInterval(tick, TICK_MS).unref();
  // Alla partenza nessun recupero delle esecuzioni perse a server spento: conta solo il minuto di adesso.
  tick();
}
