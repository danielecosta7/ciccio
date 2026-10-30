import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';
import type { Approval, ChatMessage, Effort, MessageMeta, MessageRole, PermissionLevel, Recap, RoutineRunStatus } from '../../shared/types.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'ciccio.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    session_id TEXT,
    last_activity INTEGER,
    last_result TEXT,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_agent ON messages(agent_id, id);
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    input TEXT NOT NULL,
    ts INTEGER NOT NULL,
    status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    auto_title INTEGER NOT NULL DEFAULT 1,
    session_id TEXT,
    created_at INTEGER NOT NULL,
    last_activity INTEGER,
    last_result TEXT,
    last_error TEXT,
    permission TEXT NOT NULL DEFAULT 'manual',
    model TEXT,
    effort TEXT,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS chats_agent ON chats(agent_id);
  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recaps (
    day TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER,
    platform TEXT,
    version TEXT
  );
  CREATE TABLE IF NOT EXISTS desktop_apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER,
    platform TEXT,
    version TEXT
  );
  CREATE TABLE IF NOT EXISTS routines (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    cron TEXT NOT NULL,
    chat_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_fire INTEGER,
    last_chat_id TEXT
  );
  CREATE TABLE IF NOT EXISTS routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    status TEXT NOT NULL,
    chat_id TEXT,
    note TEXT,
    duration_ms INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd REAL,
    usage_before REAL,
    usage_after REAL,
    manual INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS routine_runs_routine ON routine_runs(routine_id, ts);
  CREATE TABLE IF NOT EXISTS project_tools (
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    description TEXT NOT NULL,
    spec TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    proposed_in TEXT,
    uses INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER,
    PRIMARY KEY (agent_id, name)
  );
  CREATE TABLE IF NOT EXISTS usage_turns (
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    origin TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_turns_ts ON usage_turns(ts);
`);

// Colonne aggiunte dopo la prima versione.
const MIGRATIONS: [string, string][] = [
  ['agents', 'display_name TEXT'],
  ['agents', "permission TEXT NOT NULL DEFAULT 'manual'"],
  ['agents', 'model TEXT'],
  ['agents', 'effort TEXT'],
  ['agents', "allow_rules TEXT NOT NULL DEFAULT '[]'"],
  ['messages', 'meta TEXT'],
  ['agents', 'connectors INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'chat_id TEXT'],
  ['approvals', 'chat_id TEXT'],
  ['agents', 'hidden INTEGER NOT NULL DEFAULT 0'],
  ['chats', 'context_used INTEGER'],
  ['chats', 'context_max INTEGER'],
  ['agents', 'pc_tools INTEGER NOT NULL DEFAULT 1'],
  ['devices', 'servers TEXT'],
  ['routines', 'permission TEXT'],
  ['chats', 'turn_started INTEGER'],
  ['chats', 'worktree TEXT'],
  ['approvals', 'rule TEXT'],
];
for (const [table, col] of MIGRATIONS) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* già presente */ }
}

// Connettori di claude.ai accesi per tutte le chat (una volta sola: poi decide l'interruttore di ogni chat).
if (!db.prepare(`SELECT 1 FROM kv WHERE key = 'connectors_on_by_default'`).get()) {
  db.prepare(`UPDATE agents SET connectors = 1`).run();
  db.prepare(`INSERT INTO kv (key, value) VALUES ('connectors_on_by_default', 'true')`).run();
}

export function newChatId(): string {
  return `c${randomBytes(6).toString('hex')}`;
}

// Più chat per progetto: la conversazione che c'era diventa la "Chat principale" (una volta sola).
if (!db.prepare(`SELECT 1 FROM kv WHERE key = 'chats_migrated'`).get()) {
  db.transaction(() => {
    const rows = db.prepare(`SELECT * FROM agents`).all() as Record<string, unknown>[];
    for (const a of rows) {
      const hasMessages = db.prepare(`SELECT 1 FROM messages WHERE agent_id = ? LIMIT 1`).get(a.id);
      if (!hasMessages && !a.session_id) continue;
      const id = newChatId();
      db.prepare(`INSERT INTO chats (id, agent_id, title, auto_title, session_id, created_at, last_activity, last_result, last_error, permission, model, effort)
        VALUES (?, ?, 'Chat principale', 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, a.id, a.session_id ?? null, Date.now(), a.last_activity ?? null, a.last_result ?? null, a.last_error ?? null, a.permission ?? 'manual', a.model ?? null, a.effort ?? null);
      db.prepare(`UPDATE messages SET chat_id = ? WHERE agent_id = ? AND chat_id IS NULL`).run(id, a.id);
      db.prepare(`UPDATE approvals SET chat_id = ? WHERE agent_id = ? AND chat_id IS NULL`).run(id, a.id);
    }
    db.prepare(`UPDATE messages SET chat_id = agent_id WHERE chat_id IS NULL`).run();
    db.prepare(`UPDATE approvals SET chat_id = agent_id WHERE chat_id IS NULL`).run();
    db.prepare(`INSERT INTO kv (key, value) VALUES ('chats_migrated', 'true')`).run();
  })();
}
db.exec(`CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id)`);

// Le approvazioni rimaste aperte da un riavvio non hanno più una sessione che le aspetta.
db.prepare(`UPDATE approvals SET status = 'denied' WHERE status = 'pending'`).run();
// Lo stesso per le esecuzioni delle routine: il giro (o la coda) è sparito con il processo.
db.prepare(`UPDATE routine_runs SET status = 'interrotta', note = COALESCE(note, 'server riavviato durante l''esecuzione') WHERE status IN ('in_corso', 'in_coda')`).run();
// Chi ha creato una routine o fatto partire un giro: i valori di prima per l'utente diventano «utente».
db.prepare(`UPDATE routines SET created_by = 'utente' WHERE created_by NOT IN ('utente', 'agente', 'ciccio')`).run();
db.prepare(`UPDATE usage_turns SET origin = 'utente' WHERE origin NOT IN ('utente', 'ciccio', 'routine', 'ripresa')`).run();

export interface AgentRow {
  id: string;
  path: string;
  session_id: string | null;
  last_activity: number | null;
  last_result: string | null;
  last_error: string | null;
  /** Nome scelto dall'utente, solo in Ciccio (il repo non cambia). */
  display_name: string | null;
  /** Impostazioni ereditate dalla versione con una chat sola (ora vivono in ChatRow). */
  permission: PermissionLevel;
  model: string | null;
  effort: Effort | null;
  /** JSON: regole "consenti sempre" (es. "Bash:npm install", "WebFetch"). */
  allow_rules: string;
  /** 1 = connettori di claude.ai attivi per le chat del progetto. */
  connectors: number;
  /** 1 = nascosto in Ciccio (su GitHub e sul server non cambia niente). */
  hidden: number;
  /** 1 = strumenti dei PC collegati (companion) attivi per le chat del progetto. */
  pc_tools: number;
}

export interface ChatRow {
  id: string;
  agent_id: string;
  title: string;
  /** 1 finché il titolo lo sceglie Ciccio; 0 dopo che l'utente l'ha rinominata. */
  auto_title: number;
  session_id: string | null;
  created_at: number;
  last_activity: number | null;
  last_result: string | null;
  last_error: string | null;
  permission: PermissionLevel;
  model: string | null;
  effort: Effort | null;
  archived: number;
  /** Contesto della sessione dopo l'ultimo giro. */
  context_used: number | null;
  context_max: number | null;
  /** Inizio del giro in corso (null a giro finito): rimasto pieno all'avvio vuol dire giro interrotto (restart.ts). */
  turn_started: number | null;
  /** Worktree git della chat (le chat oltre la prima di un progetto); null = lavora nella cartella del repo. */
  worktree: string | null;
}

/** Dove scrive un messaggio: la chat e il suo progetto. */
export interface Thread { chatId: string; agentId: string }

const MSG_COLS = `id, chat_id AS chatId, agent_id AS agentId, role, text, ts, meta`;

function rowToMessage(r: Record<string, unknown>): ChatMessage {
  const m: ChatMessage = { id: Number(r.id), chatId: String(r.chatId), agentId: String(r.agentId), role: r.role as MessageRole, text: String(r.text), ts: Number(r.ts) };
  if (typeof r.meta === 'string' && r.meta) m.meta = JSON.parse(r.meta) as MessageMeta;
  return m;
}

export const store = {
  upsertAgent(id: string, agentPath: string, lastActivity: number | null) {
    db.prepare(
      `INSERT INTO agents (id, path, last_activity, connectors) VALUES (?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET path = excluded.path,
         last_activity = MAX(COALESCE(agents.last_activity, 0), COALESCE(excluded.last_activity, 0))`,
    ).run(id, agentPath, lastActivity);
  },
  agents(): AgentRow[] {
    return db.prepare(`SELECT * FROM agents ORDER BY id`).all() as AgentRow[];
  },
  agent(id: string): AgentRow | undefined {
    return db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow | undefined;
  },
  updateAgent(id: string, fields: Partial<Omit<AgentRow, 'id' | 'path'>>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE agents SET ${set} WHERE id = @id`).run({ ...fields, id });
  },
  chats(agentId: string, includeArchived = false): ChatRow[] {
    return db.prepare(`SELECT * FROM chats WHERE agent_id = ? ${includeArchived ? '' : 'AND archived = 0'} ORDER BY COALESCE(last_activity, created_at) DESC`).all(agentId) as ChatRow[];
  },
  chat(id: string): ChatRow | undefined {
    return db.prepare(`SELECT * FROM chats WHERE id = ?`).get(id) as ChatRow | undefined;
  },
  /** Chat con un giro iniziato e mai finito: all'avvio, quelle interrotte dallo spegnimento o da un crash. */
  chatsInTurn(): ChatRow[] {
    return db.prepare(`SELECT * FROM chats WHERE turn_started IS NOT NULL`).all() as ChatRow[];
  },
  createChat(row: Pick<ChatRow, 'agent_id' | 'title' | 'permission' | 'model' | 'effort'> & { auto_title?: number }): ChatRow {
    const id = newChatId();
    db.prepare(`INSERT INTO chats (id, agent_id, title, auto_title, created_at, permission, model, effort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, row.agent_id, row.title, row.auto_title ?? 1, Date.now(), row.permission, row.model, row.effort);
    return this.chat(id)!;
  },
  updateChat(id: string, fields: Partial<Omit<ChatRow, 'id' | 'agent_id'>>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE chats SET ${set} WHERE id = @id`).run({ ...fields, id });
  },
  addMessage(thread: Thread, role: MessageRole, text: string, meta?: MessageMeta): ChatMessage {
    const ts = Date.now();
    const info = db.prepare(`INSERT INTO messages (chat_id, agent_id, role, text, ts, meta) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(thread.chatId, thread.agentId, role, text, ts, meta ? JSON.stringify(meta) : null);
    return { id: Number(info.lastInsertRowid), chatId: thread.chatId, agentId: thread.agentId, role, text, ts, ...(meta ? { meta } : {}) };
  },
  updateMessageMeta(id: number, meta: MessageMeta): ChatMessage | undefined {
    db.prepare(`UPDATE messages SET meta = ? WHERE id = ?`).run(JSON.stringify(meta), id);
    const r = db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? rowToMessage(r) : undefined;
  },
  message(id: number): ChatMessage | undefined {
    const r = db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? rowToMessage(r) : undefined;
  },
  messages(chatId: string, limit = 400): ChatMessage[] {
    const rows = db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`).all(chatId, limit) as Record<string, unknown>[];
    return rows.reverse().map(rowToMessage);
  },
  /** Messaggi di un ruolo scritti dopo un certo momento, dal più vecchio. */
  messagesSince(chatId: string, role: MessageRole, ts: number): ChatMessage[] {
    const rows = db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE chat_id = ? AND role = ? AND ts > ? ORDER BY id`).all(chatId, role, ts) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  },
  countMessages(chatId: string, role: MessageRole): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND role = ?`).get(chatId, role) as { n: number }).n;
  },
  lastMessage(chatId: string, role: MessageRole): ChatMessage | undefined {
    const r = db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE chat_id = ? AND role = ? ORDER BY id DESC LIMIT 1`).get(chatId, role) as Record<string, unknown> | undefined;
    return r ? rowToMessage(r) : undefined;
  },
  addApproval(a: Approval) {
    db.prepare(`INSERT INTO approvals (id, chat_id, agent_id, tool, summary, input, ts, status, rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, a.chatId, a.agentId, a.tool, a.summary, JSON.stringify(a.input), a.ts, a.status, a.rule ?? null);
  },
  setApproval(id: string, status: Approval['status']) {
    db.prepare(`UPDATE approvals SET status = ? WHERE id = ?`).run(status, id);
  },
  /** Permessi in attesa: di una chat, oppure di tutte. */
  pendingApprovals(chatId?: string): Approval[] {
    const rows = (chatId
      ? db.prepare(`SELECT * FROM approvals WHERE status = 'pending' AND chat_id = ? ORDER BY ts`).all(chatId)
      : db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY ts`).all()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id), chatId: String(r.chat_id), agentId: String(r.agent_id), tool: String(r.tool), summary: String(r.summary),
      input: JSON.parse(String(r.input)), ts: Number(r.ts), status: r.status as Approval['status'], rule: r.rule == null ? null : String(r.rule),
    }));
  },
  recap(day: string): Recap | undefined {
    const row = db.prepare(`SELECT data FROM recaps WHERE day = ?`).get(day) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Recap) : undefined;
  },
  getKv<T>(key: string): T | undefined {
    const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  },
  setKv(key: string, value: unknown) {
    db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
  },
  latestRecap(): Recap | undefined {
    const row = db.prepare(`SELECT data FROM recaps ORDER BY day DESC LIMIT 1`).get() as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Recap) : undefined;
  },
  saveRecap(r: Recap) {
    db.prepare(`INSERT INTO recaps (day, data) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET data = excluded.data`).run(r.day, JSON.stringify(r));
  },
};

export interface CredentialRow { id: string; public_key: Buffer; counter: number; transports: string; name: string; created_at: number }

/** Passkey, sessioni e codice di attivazione (salvato solo come hash). */
export const authStore = {
  credentials(): CredentialRow[] {
    return db.prepare(`SELECT * FROM credentials ORDER BY created_at`).all() as CredentialRow[];
  },
  credential(id: string): CredentialRow | undefined {
    return db.prepare(`SELECT * FROM credentials WHERE id = ?`).get(id) as CredentialRow | undefined;
  },
  addCredential(id: string, publicKey: Buffer, counter: number, transports: string, name: string) {
    db.prepare(`INSERT INTO credentials (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, publicKey, counter, transports, name, Date.now());
  },
  updateCounter(id: string, counter: number) {
    db.prepare(`UPDATE credentials SET counter = ? WHERE id = ?`).run(counter, id);
  },
  session(hash: string): { hash: string; expires_at: number; label: string } | undefined {
    return db.prepare(`SELECT hash, expires_at, label FROM sessions WHERE hash = ?`).get(hash) as { hash: string; expires_at: number; label: string } | undefined;
  },
  addSession(hash: string, expiresAt: number, label: string) {
    db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());
    db.prepare(`INSERT INTO sessions (hash, expires_at, label, created_at) VALUES (?, ?, ?, ?)`).run(hash, expiresAt, label, Date.now());
  },
  removeCredential(id: string) {
    db.prepare(`DELETE FROM credentials WHERE id = ?`).run(id);
  },
  dropAllSessions() {
    db.prepare(`DELETE FROM sessions`).run();
  },
  dropSession(hash: string) {
    db.prepare(`DELETE FROM sessions WHERE hash = ?`).run(hash);
  },
  code(): { hash: string; expires_at: number } | undefined {
    return store.getKv<{ hash: string; expires_at: number }>('setup_code') ?? undefined;
  },
  setCode(hash: string, expiresAt: number) {
    store.setKv('setup_code', { hash, expires_at: expiresAt });
  },
  clearCode() {
    store.setKv('setup_code', null);
  },
};

export interface RoutineRow {
  id: string;
  agent_id: string;
  name: string;
  text: string;
  /** Cron a 5 campi, nel fuso di Ciccio (shared/cron.ts). */
  cron: string;
  /** Chat fissa; null = una chat nuova a ogni esecuzione. */
  chat_id: string | null;
  enabled: number;
  created_by: 'utente' | 'agente' | 'ciccio';
  created_at: number;
  /** Minuto (epoch ms) dell'ultimo scatto programmato: lo stesso minuto non riparte due volte. */
  last_fire: number | null;
  /** Chat dell'ultima esecuzione (con le chat nuove: quella da archiviare alla prossima). */
  last_chat_id: string | null;
  /** Livello delle chat nuove della routine; null = quello predefinito delle chat nuove. Lo sceglie solo l'utente. */
  permission: PermissionLevel | null;
}

export interface RoutineRunRow {
  id: string; routine_id: string; ts: number; status: RoutineRunStatus; chat_id: string | null; note: string | null;
  duration_ms: number | null; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null;
  usage_before: number | null; usage_after: number | null; manual: number;
}

/** Routine e loro esecuzioni (lo scheduler è in routines.ts). */
export const routineStore = {
  all(): RoutineRow[] {
    return db.prepare(`SELECT * FROM routines ORDER BY created_at`).all() as RoutineRow[];
  },
  get(id: string): RoutineRow | undefined {
    return db.prepare(`SELECT * FROM routines WHERE id = ?`).get(id) as RoutineRow | undefined;
  },
  add(r: Omit<RoutineRow, 'last_fire' | 'last_chat_id'>) {
    db.prepare(`INSERT INTO routines (id, agent_id, name, text, cron, chat_id, enabled, created_by, created_at, permission) VALUES (@id, @agent_id, @name, @text, @cron, @chat_id, @enabled, @created_by, @created_at, @permission)`).run(r);
  },
  update(id: string, fields: Partial<Omit<RoutineRow, 'id'>>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    db.prepare(`UPDATE routines SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  },
  remove(id: string) {
    db.transaction(() => {
      db.prepare(`DELETE FROM routine_runs WHERE routine_id = ?`).run(id);
      db.prepare(`DELETE FROM routines WHERE id = ?`).run(id);
    })();
  },
  addRun(r: RoutineRunRow) {
    db.prepare(`INSERT INTO routine_runs (id, routine_id, ts, status, chat_id, note, duration_ms, tokens_in, tokens_out, cost_usd, usage_before, usage_after, manual)
      VALUES (@id, @routine_id, @ts, @status, @chat_id, @note, @duration_ms, @tokens_in, @tokens_out, @cost_usd, @usage_before, @usage_after, @manual)`).run(r);
  },
  updateRun(id: string, fields: Partial<Omit<RoutineRunRow, 'id' | 'routine_id'>>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    db.prepare(`UPDATE routine_runs SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  },
  run(id: string): RoutineRunRow | undefined {
    return db.prepare(`SELECT * FROM routine_runs WHERE id = ?`).get(id) as RoutineRunRow | undefined;
  },
  runs(routineId: string, limit = 30): RoutineRunRow[] {
    return db.prepare(`SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY ts DESC LIMIT ?`).all(routineId, limit) as RoutineRunRow[];
  },
  /** Esecuzioni partite (non saltate) da `since` in poi, con token e costo sommati. */
  usage(routineId: string, since: number): { runs: number; tokens_in: number; tokens_out: number; cost_usd: number } {
    return db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_in), 0) AS tokens_in, COALESCE(SUM(tokens_out), 0) AS tokens_out, COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM routine_runs WHERE routine_id = ? AND ts >= ? AND status <> 'saltata'`).get(routineId, since) as { runs: number; tokens_in: number; tokens_out: number; cost_usd: number };
  },
  count(routineId: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM routine_runs WHERE routine_id = ? AND status <> 'saltata'`).get(routineId) as { n: number }).n;
  },
};

export interface ProjectToolRow {
  agent_id: string;
  /** Nome dello strumento (comando) o del server MCP. */
  name: string;
  kind: 'comando' | 'mcp';
  description: string;
  /** JSON: CommandSpec o McpSpec di projectTools.ts, così come l'utente l'ha approvato. */
  spec: string;
  created_at: number;
  /** Chat da cui è arrivata la proposta (titolo), per ricordarsi perché c'è. */
  proposed_in: string | null;
  uses: number;
  last_used: number | null;
}

/** Strumenti su misura dei progetti, approvati dall'utente con «Consenti sempre» (projectTools.ts). */
export const toolStore = {
  list(agentId: string): ProjectToolRow[] {
    return db.prepare(`SELECT * FROM project_tools WHERE agent_id = ? ORDER BY created_at`).all(agentId) as ProjectToolRow[];
  },
  get(agentId: string, name: string): ProjectToolRow | undefined {
    return db.prepare(`SELECT * FROM project_tools WHERE agent_id = ? AND name = ?`).get(agentId, name) as ProjectToolRow | undefined;
  },
  add(r: Omit<ProjectToolRow, 'uses' | 'last_used'>) {
    db.prepare(`INSERT INTO project_tools (agent_id, name, kind, description, spec, created_at, proposed_in) VALUES (@agent_id, @name, @kind, @description, @spec, @created_at, @proposed_in)`).run(r);
  },
  used(agentId: string, name: string) {
    db.prepare(`UPDATE project_tools SET uses = uses + 1, last_used = ? WHERE agent_id = ? AND name = ?`).run(Date.now(), agentId, name);
  },
  remove(agentId: string, name: string): boolean {
    return db.prepare(`DELETE FROM project_tools WHERE agent_id = ? AND name = ?`).run(agentId, name).changes > 0;
  },
};

export interface DeviceRow { id: string; name: string; token_hash: string; created_at: number; last_seen: number | null; platform: string | null; version: string | null; servers: string | null }

/** PC con il companion: il token si salva solo come hash. */
export const deviceStore = {
  all(): DeviceRow[] {
    return db.prepare(`SELECT * FROM devices ORDER BY created_at`).all() as DeviceRow[];
  },
  byHash(hash: string): DeviceRow | undefined {
    return db.prepare(`SELECT * FROM devices WHERE token_hash = ?`).get(hash) as DeviceRow | undefined;
  },
  byName(name: string): DeviceRow | undefined {
    return db.prepare(`SELECT * FROM devices WHERE name = ?`).get(name) as DeviceRow | undefined;
  },
  add(id: string, name: string, tokenHash: string) {
    db.prepare(`INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)`).run(id, name, tokenHash, Date.now());
  },
  /** Ultimi server MCP noti del PC (JSON), anche quando è spento: l'elenco degli strumenti resta uguale. */
  setServers(id: string, json: string) {
    db.prepare(`UPDATE devices SET servers = ? WHERE id = ?`).run(json, id);
  },
  /** Token nuovo per lo stesso dispositivo: quello vecchio smette di valere. */
  retoken(id: string, tokenHash: string) {
    db.prepare(`UPDATE devices SET token_hash = ? WHERE id = ?`).run(tokenHash, id);
  },
  seen(id: string, platform: string | null, version: string | null) {
    db.prepare(`UPDATE devices SET last_seen = ?, platform = COALESCE(?, platform), version = COALESCE(?, version) WHERE id = ?`).run(Date.now(), platform, version, id);
  },
  remove(id: string) {
    db.prepare(`DELETE FROM devices WHERE id = ?`).run(id);
  },
};

export interface DesktopAppRow { id: string; name: string; token_hash: string; created_at: number; last_seen: number | null; platform: string | null; version: string | null }

/** App desktop «Ciccio» collegate: come i PC del companion, il token si salva solo come hash. */
export const desktopStore = {
  all(): DesktopAppRow[] {
    return db.prepare(`SELECT * FROM desktop_apps ORDER BY created_at`).all() as DesktopAppRow[];
  },
  byHash(hash: string): DesktopAppRow | undefined {
    return db.prepare(`SELECT * FROM desktop_apps WHERE token_hash = ?`).get(hash) as DesktopAppRow | undefined;
  },
  add(id: string, name: string, tokenHash: string, platform: string | null) {
    db.prepare(`INSERT INTO desktop_apps (id, name, token_hash, created_at, platform) VALUES (?, ?, ?, ?, ?)`).run(id, name, tokenHash, Date.now(), platform);
  },
  seen(id: string, platform: string | null, version: string | null) {
    db.prepare(`UPDATE desktop_apps SET last_seen = ?, platform = COALESCE(?, platform), version = COALESCE(?, version) WHERE id = ?`).run(Date.now(), platform, version, id);
  },
  remove(id: string) {
    db.prepare(`DELETE FROM desktop_apps WHERE id = ?`).run(id);
  },
};

/** Chi ha fatto partire ogni giro di una sessione di Claude (Impostazioni › Consumi): l'utente o un automatismo. */
export const turnStore = {
  add(sessionId: string, ts: number, origin: string) {
    db.prepare(`INSERT INTO usage_turns (session_id, ts, origin) VALUES (?, ?, ?)`).run(sessionId, ts, origin);
  },
  since(ts: number): { session_id: string; ts: number; origin: string }[] {
    return db.prepare(`SELECT session_id, ts, origin FROM usage_turns WHERE ts >= ? ORDER BY ts`).all(ts) as { session_id: string; ts: number; origin: string }[];
  },
  first(): number | null {
    return (db.prepare(`SELECT MIN(ts) AS ts FROM usage_turns`).get() as { ts: number | null }).ts;
  },
  prune(before: number) {
    db.prepare(`DELETE FROM usage_turns WHERE ts < ?`).run(before);
  },
  /** Messaggi dell'utente, di Ciccio e delle routine (per i giri di prima del registro). */
  sentSince(ts: number): { role: string; text: string; ts: number; meta: string | null }[] {
    return db.prepare(`SELECT role, text, ts, meta FROM messages WHERE role IN ('user', 'ciccio') AND ts >= ? ORDER BY ts`).all(ts) as { role: string; text: string; ts: number; meta: string | null }[];
  },
};
