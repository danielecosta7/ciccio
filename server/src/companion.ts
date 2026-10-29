import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { config, mainOrigin, OWNER } from './config.js';
import { deviceStore, store, type DeviceRow } from './db.js';
import { bus } from './bus.js';
import { failed, limited, sha } from './auth.js';
import { settings } from './settings.js';
import { coveredByApp } from './desktop.js';
import { COMPANION_DOWNLOAD_PATH, COMPANION_PATH, COMPANION_PROTOCOL, COMPANION_TRANSFER_PATH, MAX_TRANSFER_BYTES, SECRET_READ_METHOD, SSH_AGENT_METHOD, SSH_BRIDGE_CLOSE, SSH_BRIDGE_DATA, SSH_BRIDGE_MAX, SSH_BRIDGE_OPEN, SSH_BRIDGE_PROPOSE, SSH_BRIDGE_REMOVE, SSH_BRIDGES_CHANGED, TRANSFER_META, TRANSFER_TOOLS, newerVersion, parseBridgeTarget, serverSlug, type BridgeProposal, type NotifyParams, type OnePasswordFeatures, type CallParams, type LocalServerState, type LocalTool, type RpcId, type TransferKind, type TransferParams } from '../../shared/companion.js';
import { BridgeTable, type BridgeClosed } from '../../shared/node/ponte.js';
import type { ChatMessage, CompanionView } from '../../shared/types.js';
import { USAGE_METHOD } from '../../shared/consumi.js';
import { savePcUsage } from './consumi.js';
import { protectedInRepo } from './confine.js';
import { downloadsDir, listed, updateFor } from './releases.js';

// Companion dei PC: un piccolo programma sul Mac o sul PC Windows apre una WebSocket in uscita
// verso Ciccio, con il token del dispositivo, e rende disponibili i suoi server MCP locali
// (Affinity, Chrome su profilo dedicato…). Sul PC non si apre nessuna porta.
//
// Per ogni PC collegato, le sessioni agente ricevono un server MCP "pc_<nome>" i cui strumenti
// si chiamano mcp__pc_<nome>__<server>_<strumento>. Ogni chiamata passa da canUseTool, cioè dagli
// stessi livelli di autorizzazione delle chat (policy.ts), e poi viene inoltrata al PC.

const CALL_TIMEOUT_MS = 10 * 60_000;
const PING_MS = 30_000;
/** Limite dell'API sui nomi degli strumenti. */
const TOOL_NAME_MAX = 64;

interface Pending { done: (r: CallToolResult) => void }
interface RawPending { resolve: (r: unknown) => void; reject: (e: Error) => void }

interface Link {
  device: DeviceRow;
  socket: WebSocket;
  platform: string | null;
  version: string | null;
  servers: LocalServerState[];
  /** Il PC mostra gli avvisi di Ciccio come notifiche del sistema. */
  notify: boolean;
  pending: Map<RpcId, Pending>;
  /** Richieste che non sono strumenti (1Password): risposta grezza. */
  raw: Map<RpcId, RawPending>;
  onePassword: OnePasswordFeatures;
  nextId: number;
  alive: boolean;
  /** Da quando è collegato (per scegliere il PC stabile tra più PC con 1Password). */
  connectedAt: number;
  /** Ponti SSH che il PC consente ("host:porta", ssh.ponti nella sua config) e quelli aperti adesso. */
  sshBridges: string[];
  bridges: BridgeTable;
}

/** PC collegati adesso, per id del dispositivo. */
const links = new Map<string, Link>();
/** Server MCP delle sessioni in corso, per avvisarle quando il PC cambia strumenti. */
const instances = new Map<string, Set<McpServer>>();

export const mcpNameOf = (device: { name: string }) => `pc_${device.name}`;

const errorResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

// Elenco stabile: le sessioni vedono sempre gli ultimi strumenti noti di ogni PC, acceso o spento.
// Se l'elenco cambiasse quando il Mac va in stop o si risveglia, ogni sessione ripagherebbe per intero
// la sua conversazione al giro dopo (la cache dei prompt vale solo se l'inizio della richiesta è identico).
// Da spento, lo strumento risponde che il PC non è collegato.

/** Ultimi server noti del PC, salvati nel database. */
function knownServers(deviceId: string): LocalServerState[] {
  const raw = deviceStore.all().find((d) => d.id === deviceId)?.servers;
  if (!raw) return [];
  try { return cleanServers(JSON.parse(raw)) ?? []; } catch { return []; }
}

/**
 * Unisce quello che il PC dice adesso con quello che si sapeva: un server online porta i suoi strumenti di oggi,
 * uno spento (es. Affinity chiuso) tiene quelli dell'ultima volta. Salva solo se è cambiato qualcosa.
 * Restituisce true se l'elenco degli strumenti è cambiato davvero.
 */
function rememberServers(deviceId: string, live: LocalServerState[]): boolean {
  const known = new Map(knownServers(deviceId).map((s) => [s.name, s]));
  for (const s of live) {
    if (s.status === 'online' || !known.has(s.name)) known.set(s.name, { name: s.name, status: 'online', instructions: s.instructions, tools: s.tools });
  }
  const merged = [...known.values()].sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ ...s, status: 'online' as const, error: undefined }));
  const json = JSON.stringify(merged);
  const before = deviceStore.all().find((d) => d.id === deviceId)?.servers ?? null;
  if (json === before) return false;
  deviceStore.setServers(deviceId, json);
  return true;
}

/** Strumenti di un PC: nome visto dall'agente → server locale e strumento originale. */
function exposedTools(device: { name: string }, servers: LocalServerState[], onlyOnline = true): { exposed: string; server: string; tool: LocalTool }[] {
  const max = TOOL_NAME_MAX - `mcp__${mcpNameOf(device)}__`.length;
  const out: { exposed: string; server: string; tool: LocalTool }[] = [];
  const seen = new Set<string>();
  for (const s of servers) {
    if (onlyOnline && s.status !== 'online') continue;
    for (const t of s.tools) {
      const exposed = `${s.name}_${t.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, max);
      if (seen.has(exposed)) continue;
      seen.add(exposed);
      out.push({ exposed, server: s.name, tool: t });
    }
  }
  return out;
}

export function companions(): CompanionView[] {
  return deviceStore.all().map((d) => {
    const l = links.get(d.id);
    return {
      id: d.id, name: d.name, mcpName: mcpNameOf(d), online: !!l,
      platform: l?.platform ?? d.platform, version: l?.version ?? d.version,
      createdAt: d.created_at, lastSeen: l ? Date.now() : d.last_seen, notifications: !!l?.notify,
      onePassword: l ? l.onePassword : null,
      sshBridges: l ? l.sshBridges : null,
      servers: (l?.servers ?? []).map((s) => ({
        name: s.name, status: s.status, error: s.error,
        tools: s.tools.map((t) => ({ name: t.name, description: t.description?.split('\n')[0].slice(0, 200), readOnly: t.annotations?.readOnlyHint === true })),
      })),
    };
  });
}

function publish() {
  bus.emit({ type: 'companions', companions: companions() });
}

function send(link: Link, msg: unknown) {
  if (link.socket.readyState === link.socket.OPEN) link.socket.send(JSON.stringify(msg));
}

/** Le sessioni aperte rileggono l'elenco degli strumenti di quel PC. */
function toolsChanged(deviceId: string) {
  for (const inst of instances.get(deviceId) ?? []) {
    if (inst.isConnected()) inst.sendToolListChanged();
  }
}

function resultText(r: CallToolResult): string {
  return (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n').slice(0, 2000);
}

function callOnPc(link: Link, params: CallParams, signal?: AbortSignal): Promise<CallToolResult> {
  const id = link.nextId++;
  return new Promise((resolve) => {
    const cancel = (reason: string) => send(link, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } });
    const onAbort = () => { cancel('sessione interrotta'); done(errorResult('Chiamata interrotta.')); };
    const timer = setTimeout(() => { cancel('tempo scaduto'); done(errorResult('Il PC non ha risposto entro 10 minuti.')); }, CALL_TIMEOUT_MS);
    const done = (r: CallToolResult) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (link.pending.delete(id)) resolve(r);
    };
    link.pending.set(id, { done });
    signal?.addEventListener('abort', onAbort, { once: true });
    send(link, { jsonrpc: '2.0', id, method: 'tools/call', params });
  });
}

/** Richiesta al PC che non passa dagli strumenti MCP (1Password): aspetta la risposta o l'errore. */
function request(link: Link, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const id = link.nextId++;
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); link.raw.delete(id); };
    const fail = (e: Error, reason: string) => { send(link, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } }); cleanup(); reject(e); };
    const onAbort = () => fail(new Error('richiesta interrotta'), 'sessione interrotta');
    const timer = setTimeout(() => fail(new Error(`il PC "${link.device.name}" non ha risposto in tempo`), 'tempo scaduto'), timeoutMs);
    link.raw.set(id, { resolve: (r) => { cleanup(); resolve(r); }, reject: (e) => { cleanup(); reject(e); } });
    signal?.addEventListener('abort', onAbort, { once: true });
    send(link, { jsonrpc: '2.0', id, method, params });
  });
}

/**
 * PC collegato con questa funzione di 1Password. Se l'utente ha scelto un PC (Impostazioni › Credenziali),
 * solo quello: un Mac in stop col coperchio chiuso risulta collegato ma nessuno può approvare la richiesta.
 * Altrimenti, tra quelli che la offrono, quello collegato da più tempo.
 */
function onePasswordLink(what: keyof OnePasswordFeatures): Link | null {
  const chosen = settings().onePasswordDevice;
  const offering = [...links.values()].filter((l) => l.onePassword[what]);
  if (chosen) return offering.find((l) => l.device.id === chosen) ?? null;
  return offering.sort((a, b) => a.connectedAt - b.connectedAt)[0] ?? null;
}

export function onePasswordAvailable(what: keyof OnePasswordFeatures): string | null {
  return onePasswordLink(what)?.device.name ?? null;
}

/** Nome del PC scelto per 1Password nelle Impostazioni, null se la scelta è automatica. */
export function onePasswordChosen(): string | null {
  const id = settings().onePasswordDevice;
  return id ? deviceStore.all().find((d) => d.id === id)?.name ?? null : null;
}

/**
 * Un messaggio ssh-agent all'agent SSH di 1Password del PC: la risposta, o null se nessun PC lo offre.
 * `bind`: il session-bind@openssh.com dello stesso collegamento, che il PC usa per dire a quale server serve la firma.
 */
export async function sshAgentOnPc(message: Buffer, signal?: AbortSignal, bind?: Buffer | null): Promise<Buffer | null> {
  const link = onePasswordLink('sshAgent');
  if (!link) return null;
  // Il PC chiede conferma (fino a 90 secondi) prima di passare la firma a 1Password.
  const r = await request(link, SSH_AGENT_METHOD, { message: message.toString('base64'), ...(bind ? { bind: bind.toString('base64') } : {}) }, 150_000, signal) as { message?: unknown };
  if (typeof r?.message !== 'string') throw new Error('risposta non valida dal PC');
  return Buffer.from(r.message, 'base64');
}

/**
 * op read sul PC (Touch ID o Windows Hello in 1Password). Il valore resta in memoria solo per chi l'ha chiesto.
 * Prima il PC chiede conferma con il riferimento esatto (consensi.ts del companion): `motivo` compare nella finestra.
 */
export async function readSecretOnPc(ref: string, signal?: AbortSignal, motivo?: string): Promise<string> {
  const link = onePasswordLink('cli');
  if (!link) {
    const chosen = onePasswordChosen();
    throw new Error(chosen
      ? `1Password è impostato sul PC "${chosen}" (Impostazioni › Credenziali), che adesso non è collegato o non ha la CLI op: accendilo con il companion o cambia PC.`
      : 'Nessun PC collegato con la CLI di 1Password: serve il Mac o il PC Windows acceso con il companion e op installato (Impostazioni › Credenziali).');
  }
  // Finestra sul PC (fino a 2 minuti) e poi 1Password (fino a 2 minuti).
  const r = await request(link, SECRET_READ_METHOD, { ref, ...(motivo ? { motivo: motivo.slice(0, 300) } : {}) }, 270_000, signal) as { value?: unknown };
  if (typeof r?.value !== 'string') throw new Error('risposta non valida dal PC');
  return r.value;
}

// ── Ponti SSH attraverso il PC ──────────────────────────────────────────
// Per i server SSH della rete di un PC (sshBridge.ts sul server, ponte.ts sul companion). Decide il PC: si apre solo
// verso le destinazioni che lui dice di consentire, e il PC lo ricontrolla. Se più PC consentono la stessa
// destinazione si usa quello collegato per ultimo (di solito quello in ufficio adesso).

/** "host:porta" validi, senza doppioni: quelli che il PC dice di consentire. */
function cleanBridges(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw.slice(0, 100)) { const t = typeof v === 'string' ? parseBridgeTarget(v) : null; if (t) out.add(t.key); }
  return [...out];
}

/** PC collegato che consente questa destinazione: l'ultimo collegato. */
function bridgeLink(key: string): Link | null {
  return [...links.values()].filter((l) => l.sshBridges.includes(key)).sort((a, b) => b.connectedAt - a.connectedAt)[0] ?? null;
}

/** Riga per il messaggio dell'agente: i server raggiungibili adesso attraverso i PC accesi, vuota se nessuno. */
export function bridgesPrompt(): string {
  const parts = [...links.values()].filter((l) => l.sshBridges.length).sort((a, b) => a.device.name.localeCompare(b.device.name))
    .map((l) => `${l.sshBridges.join(', ')} (PC "${l.device.name}")`);
  return parts.length ? `- Server SSH raggiungibili attraverso i PC accesi (ponti SSH, ssh li usa da solo): ${parts.join('; ')}.` : '';
}

/** Nome del PC che farebbe da ponte verso host:porta, null se nessuno. */
export function bridgePcFor(host: string, port: number): string | null {
  const t = parseBridgeTarget(host, port);
  return t ? bridgeLink(t.key)?.device.name ?? null : null;
}

/**
 * Apre un ponte verso host:porta dal PC che lo consente e ci collega `sock` (che da lì in poi porta solo i byte di
 * ssh). Prima di collegarlo chiama `ready` (il server scrive OK al client), dopo la risposta del PC e prima di
 * qualunque byte. null se nessun PC collegato consente la destinazione; un errore con il motivo se il PC rifiuta.
 */
export async function openBridgeOnPc(host: string, port: number, sock: Socket, ready: (pc: string) => void, onClose: BridgeClosed, signal?: AbortSignal): Promise<{ pc: string } | null> {
  const t = parseBridgeTarget(host, port);
  const link = t ? bridgeLink(t.key) : null;
  if (!t || !link) return null;
  if (link.bridges.size >= SSH_BRIDGE_MAX) throw new Error(`già ${SSH_BRIDGE_MAX} ponti SSH aperti dal PC "${link.device.name}"`);
  const id = `p${randomBytes(8).toString('hex')}`;
  link.bridges.reserve(id);
  try {
    await request(link, SSH_BRIDGE_OPEN, { id, host: t.host, port: t.port }, 20_000, signal);
  } catch (e) {
    link.bridges.close(id, (e as Error).message);
    throw e;
  }
  // Il PC si è scollegato mentre rispondeva: la prenotazione non c'è più.
  if (!link.bridges.has(id)) throw new Error(`il PC "${link.device.name}" si è scollegato`);
  ready(link.device.name);
  link.bridges.attach(id, sock, onClose);
  return { pc: link.device.name };
}

/** Il PC con questo id, se è collegato. */
const linkOf = (deviceId: string) => links.get(deviceId) ?? null;

/** Strumenti che le sessioni vedono per un PC: gli ultimi noti, acceso o spento. */
const listedTools = (device: DeviceRow) => exposedTools(device, knownServers(device.id), false);

// ── File tra il repo dell'agente e il PC ────────────────────────────────
// scarica_da_ciccio e carica_su_ciccio del server «file» del companion. Ciccio controlla il percorso nel repo
// del progetto dell'agente che chiama e prepara un token monouso, valido pochi minuti, legato a quel PC e a quel
// file; il companion lo usa con il token del dispositivo su COMPANION_TRANSFER_PATH. Dove scrivere sul PC lo
// controlla il companion (cartelle consentite); Ciccio non può allargarle.

/** Chi chiama gli strumenti del PC: il progetto (il suo repo) e la chat, per i trasferimenti di file. */
export interface PcContext { repoDir: string; who: string }

const TRANSFER_TTL_MS = 5 * 60_000;
interface Transfer { kind: TransferKind; deviceId: string; repo: string; abs: string; rel: string; size?: number; dev?: number; ino?: number; overwrite: boolean; who: string; expires: number }
const transfers = new Map<string, Transfer>();

const insideDir = (parent: string, child: string) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

/** realpath del tratto che esiste + il resto (che non esiste ancora). */
function realLoose(abs: string): string {
  const tail: string[] = [];
  for (let head = abs; ;) {
    try { return path.join(fs.realpathSync(head), ...tail.reverse()); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = path.dirname(head);
      if (parent === head) throw e;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/** Percorso chiesto dall'agente → percorso reale nel repo, o il motivo del rifiuto. Mai fuori dal repo, mai in .git. */
function repoTarget(repo: string, raw: string): { abs: string; rel: string } | string {
  if (!raw.trim() || raw.includes('\0')) return 'Percorso nel repo mancante o non valido.';
  const abs = realLoose(path.resolve(repo, raw.trim()));
  if (!insideDir(repo, abs) || abs === repo) return `Il percorso deve stare dentro il repo del progetto: ${raw}`;
  const rel = path.relative(repo, abs);
  if (rel.split(path.sep).includes('.git')) return 'I file dentro .git non si scambiano con il PC.';
  return { abs, rel: rel.split(path.sep).join('/') };
}

/**
 * Destinazione di un upload: nel repo, non un collegamento né una cartella, e se c'è già solo con sovrascrivi. Mai
 * nei file che decidono git e Claude Code (.claude/, .mcp.json, .gitmodules a qualsiasi profondità) né nei worktree
 * delle altre chat: un file dal PC lì dentro deciderebbe hook e permessi del progetto.
 */
function uploadTarget(repo: string, raw: string, overwrite: boolean): { abs: string; rel: string } | string {
  const t = repoTarget(repo, raw);
  if (typeof t === 'string') return t;
  if (protectedInRepo(t.rel)) return `${t.rel} decide permessi, hook, server MCP o git del progetto (o è il lavoro di un'altra chat): dal PC non si scrive.`;
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(t.abs); } catch { /* nuovo */ }
  if (st?.isSymbolicLink()) return `Nel repo c'è un collegamento in ${t.rel}: non ci scrivo.`;
  if (st && !st.isFile()) return `Nel repo c'è una cartella in ${t.rel}: indica il percorso completo del file.`;
  if (st && !overwrite) return `Nel repo c'è già ${t.rel}: per sostituirlo passa sovrascrivi=true.`;
  return t;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Prepara il trasferimento chiesto dall'agente: i parametri per il companion, o il motivo del rifiuto. */
async function prepareTransfer(kind: TransferKind, device: DeviceRow, ctx: PcContext | undefined, args: Record<string, unknown> | undefined): Promise<TransferParams | string> {
  if (!ctx) return 'Lo scambio di file con il PC c\'è solo per gli agenti dei progetti, con i file del loro repo.';
  const arg = TRANSFER_TOOLS[kind].repoArg;
  const raw = args?.[arg];
  if (typeof raw !== 'string') return `Manca ${arg} (percorso nel repo, relativo alla radice).`;
  let repo: string;
  try { repo = fs.realpathSync(ctx.repoDir); } catch { return 'Il repo del progetto non c\'è sul server.'; }
  let t: { abs: string; rel: string } | string;
  let size: number | undefined;
  let dev: number | undefined;
  let ino: number | undefined;
  let sha256: string | undefined;
  if (kind === 'download') {
    t = repoTarget(repo, raw);
    if (typeof t === 'string') return t;
    let st: fs.Stats;
    // lstat sul percorso già risolto: se nel frattempo è diventato un collegamento, non si segue.
    try { st = fs.lstatSync(t.abs); } catch { return `Nel repo non c'è ${t.rel}.`; }
    if (!st.isFile()) return `${t.rel} non è un file.`;
    if (st.size > MAX_TRANSFER_BYTES) return `${t.rel} è troppo grande (${st.size} byte, massimo ${MAX_TRANSFER_BYTES}).`;
    size = st.size;
    dev = st.dev;
    ino = st.ino;
    sha256 = await sha256File(t.abs);
  } else {
    t = uploadTarget(repo, raw, args?.sovrascrivi === true);
    if (typeof t === 'string') return t;
  }
  const token = randomBytes(32).toString('base64url');
  transfers.set(token, { kind, deviceId: device.id, repo, abs: t.abs, rel: t.rel, size, dev, ino, overwrite: args?.sovrascrivi === true, who: ctx.who, expires: Date.now() + TRANSFER_TTL_MS });
  setTimeout(() => transfers.delete(token), TRANSFER_TTL_MS).unref();
  return { verso: kind, token, percorso: t.rel, ...(kind === 'download' ? { dimensione: size, sha256 } : { massimo: MAX_TRANSFER_BYTES }) };
}

/**
 * Apre il file di un download preparato senza seguire collegamenti: deve essere lo stesso file controllato allora
 * (stesso dispositivo e inode, stessa dimensione) e, su Linux, stare ancora in quel percorso del repo. Così un
 * collegamento messo al suo posto (o al posto di una cartella del percorso) dopo la preparazione non porta fuori.
 * Il descrittore aperto, null se il file non c'è più, o il motivo del rifiuto.
 */
function openPrepared(t: Transfer): number | string | null {
  let fd: number;
  try { fd = fs.openSync(t.abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'il file è cambiato nel frattempo: riprova';
  }
  try {
    const st = fs.fstatSync(fd);
    const real = process.platform === 'linux' ? fs.readlinkSync(`/proc/self/fd/${fd}`) : fs.realpathSync(t.abs);
    if (st.isFile() && st.dev === t.dev && st.ino === t.ino && st.size === t.size && real === t.abs && insideDir(t.repo, real)) return fd;
  } catch { /* sotto */ }
  fs.closeSync(fd);
  return 'il file è cambiato nel frattempo: riprova';
}

/** Il trasferimento del token, se è di quel PC, di quel verso e non è scaduto: vale una volta sola. */
function takeTransfer(token: string, kind: TransferKind, device: DeviceRow): Transfer | null {
  const t = transfers.get(token);
  if (!t || t.kind !== kind || t.deviceId !== device.id || t.expires < Date.now()) return null;
  transfers.delete(token);
  return t;
}

/** Server MCP "pc_<nome>" per una sessione: elenco fisso (ultimo noto), chiamate al PC se è collegato. */
function makeInstance(device: DeviceRow, ctx?: PcContext): McpServer {
  const deviceId = device.id;
  const name = mcpNameOf(device);
  // Le istruzioni dei server finiscono nel prompt di sistema: anche loro dall'ultimo elenco noto, non da chi è acceso adesso.
  const instructions = knownServers(deviceId)
    .filter((s) => s.instructions?.trim())
    .map((s) => `Server "${s.name}" (strumenti ${name}__${s.name}_*):\n${s.instructions!.trim()}`)
    .join('\n\n');
  const inst = new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: { listChanged: true } }, instructions: instructions || undefined });
  inst.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listedTools(device).map(({ exposed, server, tool: { _meta: _, ...tool } }) => ({
      ...tool, name: exposed,
      description: `[${server} sul PC "${device.name}" di ${OWNER}] ${tool.description ?? ''}`.trim(),
    })),
  }));
  inst.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const l = links.get(deviceId);
    if (!l) return errorResult(`Il PC "${device.name}" non è collegato in questo momento: chiedi a ${OWNER} di accenderlo o di avviare il companion.`);
    const t = exposedTools(l.device, l.servers).find((x) => x.exposed === req.params.name);
    if (!t) {
      const known = listedTools(device).find((x) => x.exposed === req.params.name);
      return errorResult(known
        ? `${known.server} non è disponibile sul PC "${device.name}" in questo momento (programma chiuso o non pronto): chiedi a ${OWNER} di aprirlo.`
        : `Lo strumento ${req.params.name} non c'è sul PC "${device.name}".`);
    }
    // Scambio di file con il repo: Ciccio prepara il file (o la destinazione) per questa sola chiamata.
    const kind = t.tool._meta?.[TRANSFER_META];
    if (kind === 'download' || kind === 'upload') {
      const transfer = await prepareTransfer(kind, l.device, ctx, req.params.arguments);
      if (typeof transfer === 'string') return errorResult(transfer);
      return callOnPc(l, { server: t.server, name: t.tool.name, arguments: req.params.arguments, transfer }, extra.signal);
    }
    return callOnPc(l, { server: t.server, name: t.tool.name, arguments: req.params.arguments }, extra.signal);
  });
  let set = instances.get(deviceId);
  if (!set) instances.set(deviceId, (set = new Set()));
  set.add(inst);
  inst.server.onclose = () => set.delete(inst);
  return inst;
}

/**
 * Server MCP dei PC registrati (accesi o spenti, sempre gli stessi e nello stesso ordine), da passare a query():
 * istanze nuove per ogni sessione. `ctx`: il progetto che chiama, per scambiare file con il suo repo.
 */
export function pcMcpServers(ctx?: PcContext): Record<string, McpSdkServerConfigWithInstance> {
  const out: Record<string, McpSdkServerConfigWithInstance> = {};
  for (const device of deviceStore.all().sort((a, b) => a.name.localeCompare(b.name))) {
    const tools = listedTools(device);
    if (!tools.length) continue;
    const name = mcpNameOf(device);
    out[name] = {
      type: 'sdk', name, instance: makeInstance(device, ctx), timeout: CALL_TIMEOUT_MS,
      // Ogni chiamata chiede a canUseTool, anche se una regola delle impostazioni utente la coprirebbe.
      tools: tools.map((t) => ({ name: t.exposed, permission_policy: 'always_ask' as const })),
    };
  }
  return out;
}

/** A sessione finita: chiude le istanze create da pcMcpServers(). */
export function releasePcServers(servers: Record<string, McpSdkServerConfigWithInstance>) {
  for (const cfg of Object.values(servers)) {
    for (const set of instances.values()) set.delete(cfg.instance);
    void cfg.instance.close().catch(() => undefined);
  }
}

/**
 * Riga sullo stato dei PC adesso (va nel messaggio, non nelle istruzioni): quali sono accesi e cosa offrono.
 * Vuota se non c'è nessun PC con strumenti.
 */
export function pcPrompt(servers: Record<string, McpSdkServerConfigWithInstance>): string {
  const on: string[] = [];
  const off: string[] = [];
  for (const name of Object.keys(servers)) {
    const link = [...links.values()].find((l) => mcpNameOf(l.device) === name);
    const parts = link?.servers.filter((s) => s.status === 'online').map((s) => `${s.name} (${s.tools.length} strumenti)`) ?? [];
    if (parts.length) on.push(`${name}: ${parts.join(', ')}`); else off.push(name);
  }
  if (!on.length && !off.length) return '';
  const lines: string[] = [];
  if (on.length) lines.push(`- PC di ${OWNER} accesi adesso (strumenti mcp__pc_<pc>__<server>_<nome>): ${on.join('; ')}. Girano sul suo computer con i suoi programmi: usali solo quando servono al lavoro.`);
  if (off.length) lines.push(`- Spenti adesso: ${off.join(', ')}. I loro strumenti restano nell'elenco ma rispondono che il PC non è collegato.`);
  return lines.join('\n');
}

/** Per policy.ts: lo strumento di un PC si dichiara di sola lettura (true), un'azione (false) o non lo dice? */
export function pcToolHints(toolName: string): { readOnly?: boolean } | undefined {
  const m = /^mcp__(pc_[a-z0-9]+)__(.+)$/.exec(toolName);
  if (!m) return undefined;
  const device = deviceStore.all().find((d) => mcpNameOf(d) === m[1]);
  const t = device ? listedTools(device).find((x) => x.exposed === m[2]) : undefined;
  const hint = t?.tool.annotations?.readOnlyHint;
  return { readOnly: typeof hint === 'boolean' ? hint : undefined };
}

// ── Aggiornamento automatico ────────────────────────────────────────────

/**
 * Al PC che ha una versione più vecchia si dice quale file scaricare, con il manifest firmato
 * (downloads/companion.json e .sig, vedi releases.ts): il companion controlla le firme prima di installare.
 */
function offerUpdate(link: Link) {
  const params = updateFor('companion.json', COMPANION_DOWNLOAD_PATH, link.platform, link.version, newerVersion);
  if (params) send(link, { jsonrpc: '2.0', method: 'companion/update', params });
}

// ── Notifiche ───────────────────────────────────────────────────────────

/** Un avviso di Ciccio diventa una notifica del sistema sui PC che le hanno attive. */
function notifyPcs(m: ChatMessage) {
  if (m.meta?.kind !== 'notice') return;
  const meta = m.meta;
  const agent = store.agent(meta.agentId);
  const name = agent?.display_name?.trim() || meta.agentId;
  const params: NotifyParams = {
    id: String(m.id),
    title: `Ciccio · ${name}`,
    body: m.text.slice(0, 400),
    url: `${mainOrigin}/agente/${encodeURIComponent(meta.agentId)}/${encodeURIComponent(meta.chatId)}`,
    tone: meta.tone,
  };
  // Sullo stesso PC c'è l'app desktop accesa: la notifica la mostra lei (con i pulsanti), non il companion.
  for (const link of links.values()) if (link.notify && !coveredByApp(link.device.id)) send(link, { jsonrpc: '2.0', method: 'companion/notify', params });
}

// ── Messaggi dal PC ─────────────────────────────────────────────────────

const ToolSchema = z.object({
  name: z.string().min(1).max(128),
  title: z.string().max(200).optional(),
  description: z.string().max(20_000).optional(),
  inputSchema: z.looseObject({ type: z.literal('object') }),
  annotations: z.looseObject({}).optional(),
  _meta: z.looseObject({}).optional(),
});
const ServerSchema = z.object({
  name: z.string().min(1).max(64),
  status: z.enum(['online', 'offline']),
  error: z.string().max(500).optional(),
  instructions: z.string().max(20_000).optional(),
  tools: z.array(ToolSchema).max(300),
});
const ServersSchema = z.array(ServerSchema).max(32);

function cleanServers(raw: unknown): LocalServerState[] | null {
  const parsed = ServersSchema.safeParse(raw);
  if (!parsed.success) return null;
  const seen = new Set<string>();
  const out: LocalServerState[] = [];
  for (const s of parsed.data) {
    const name = serverSlug(s.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ ...s, name, tools: s.tools as LocalTool[] });
  }
  return out;
}

function onMessage(link: Link, raw: string) {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
  if (msg.id != null && ('result' in msg || 'error' in msg)) {
    const raw = link.raw.get(msg.id as RpcId);
    if (raw) {
      const e = msg.error as { message?: unknown } | undefined;
      if ('error' in msg) raw.reject(new Error(typeof e?.message === 'string' ? e.message.slice(0, 400) : 'errore dal PC'));
      else raw.resolve(msg.result);
      return;
    }
    const p = link.pending.get(msg.id as RpcId);
    if (!p) return;
    if ('error' in msg) {
      const e = msg.error as { message?: unknown } | undefined;
      p.done(errorResult(`Errore dal PC: ${typeof e?.message === 'string' ? e.message : 'sconosciuto'}`));
    } else {
      const r = msg.result as CallToolResult | undefined;
      p.done(r && Array.isArray(r.content) ? r : errorResult('Risposta non valida dal PC.'));
    }
    return;
  }
  if (msg.method === USAGE_METHOD) { savePcUsage(link.device.id, msg.params); return; }
  if (msg.method === SSH_BRIDGE_DATA) { link.bridges.data(msg.params); return; }
  if (msg.method === SSH_BRIDGE_CLOSE) { link.bridges.remoteClose(msg.params); return; }
  if (msg.method === SSH_BRIDGES_CHANGED) {
    link.sshBridges = cleanBridges((msg.params as { targets?: unknown } | undefined)?.targets);
    publish();
    return;
  }
  if (msg.method === 'companion/onepassword') {
    const op = (msg.params ?? {}) as Partial<OnePasswordFeatures>;
    link.onePassword = { sshAgent: op.sshAgent === true, cli: op.cli === true };
    publish();
    return;
  }
  if (msg.method === 'companion/hello' || msg.method === 'companion/servers') {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (msg.method === 'companion/hello') {
      link.platform = typeof params.platform === 'string' ? params.platform.slice(0, 40) : null;
      link.version = typeof params.version === 'string' ? params.version.slice(0, 40) : null;
      link.notify = params.notifications === true;
      const op = (params.onePassword ?? {}) as Partial<OnePasswordFeatures>;
      link.onePassword = { sshAgent: op.sshAgent === true, cli: op.cli === true };
      link.sshBridges = cleanBridges(params.sshBridges);
      const current = links.get(link.device.id);
      if (current && current !== link) {
        if (current.version && link.version && newerVersion(current.version, link.version)) {
          link.socket.close(4001, `Copia vecchia del companion (${link.version}): su questo dispositivo è già collegata la ${current.version}. Chiudi questa copia o aggiornala.`);
          return;
        }
        // Prima il nuovo, poi la chiusura del vecchio: così il suo «close» non toglie il collegamento buono.
        links.set(link.device.id, link);
        current.socket.close(4000, 'sostituito da un nuovo collegamento');
      }
      // La versione salvata è la più nuova vista: una copia vecchia rimasta sola non la riporta indietro.
      const known = deviceStore.all().find((d) => d.id === link.device.id)?.version ?? null;
      const older = !!(known && link.version && newerVersion(known, link.version));
      deviceStore.seen(link.device.id, link.platform, older ? null : link.version);
      offerUpdate(link);
    }
    if (links.get(link.device.id) !== link) return;
    const servers = cleanServers(params.servers);
    let changed = false;
    // Gli strumenti noti li aggiorna solo il companion più nuovo visto: una copia vecchia (che si aggiorna da sola
    // poco dopo) non deve far tornare indietro l'elenco, e poi avanti, a ogni collegamento.
    const known = deviceStore.all().find((d) => d.id === link.device.id)?.version ?? null;
    const older = !!(known && link.version && newerVersion(known, link.version));
    if (servers) { link.servers = servers; if (!older) changed = rememberServers(link.device.id, servers); }
    publish();
    // Le sessioni rileggono gli strumenti solo se l'elenco è cambiato davvero (programma nuovo, strumenti nuovi).
    if (changed) toolsChanged(link.device.id);
  }
}

// ── Rotte ───────────────────────────────────────────────────────────────

const deviceOf = new WeakMap<FastifyRequest, DeviceRow>();

/** Il companion entra solo con un token di dispositivo valido, sia da Caddy sia da Tailscale. */
async function deviceAuth(req: FastifyRequest, reply: FastifyReply) {
  if (limited(req)) return reply.code(429).send({ error: 'Troppi tentativi, riprova tra qualche minuto.' });
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const device = token ? deviceStore.byHash(sha(token)) : undefined;
  if (!device) { failed(req); return reply.code(401).send({ error: 'token del dispositivo non valido' }); }
  deviceOf.set(req, device);
}

export function registerCompanion(app: FastifyInstance) {
  app.get(COMPANION_PATH, { websocket: true, preValidation: deviceAuth }, (socket, req) => {
    const device = deviceOf.get(req);
    if (!device) { socket.close(4001, 'non autorizzato'); return; }
    // Un solo collegamento per dispositivo. Se ce n'è già uno, chi resta si decide al saluto (companion/hello),
    // quando si conosce la versione: prima il nuovo sostituiva subito il vecchio, e due copie del companion con lo
    // stesso token (es. una vecchia rimasta accesa sul Mac) si buttavano fuori a vicenda ogni minuto, alternando i
    // loro elenchi di strumenti. Ogni cambio di elenco fa ripagare per intero la conversazione a tutte le sessioni.
    const link: Link = {
      device, socket, platform: null, version: null, servers: [], notify: false, pending: new Map(), raw: new Map(), onePassword: { sshAgent: false, cli: false }, nextId: 1, alive: true, connectedAt: Date.now(),
      sshBridges: [], bridges: new BridgeTable({ send: (m) => send(link, m), buffered: () => socket.bufferedAmount }),
    };
    if (!links.has(device.id)) { links.set(device.id, link); deviceStore.seen(device.id, null, null); }
    // Da dove arriva: dietro un proxy fidato (CICCIO_TRUST_PROXY) l'indirizzo vero, che req.ip prende da X-Forwarded-For.
    // Serve a capire chi si collega con il token di un dispositivo (es. un Mac che si risveglia da solo).
    const from = req.ip;
    app.log.info(`Companion collegato: ${device.name} da ${from}`);
    socket.once('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString()) as { method?: string; params?: { platform?: unknown; version?: unknown } };
        if (m.method === 'companion/hello') app.log.info(`Companion ${device.name}: ${String(m.params?.platform ?? '?').slice(0, 40)} · versione ${String(m.params?.version ?? '?').slice(0, 20)}`);
      } catch { /* non JSON: lo scarta onMessage */ }
    });
    send(link, { jsonrpc: '2.0', method: 'companion/welcome', params: { protocol: COMPANION_PROTOCOL, device: device.name, mcpName: mcpNameOf(device) } });
    socket.on('pong', () => { link.alive = true; });
    socket.on('message', (raw: Buffer) => onMessage(link, raw.toString()));
    socket.on('close', () => {
      for (const p of [...link.pending.values()]) p.done(errorResult('Il PC si è scollegato durante la chiamata.'));
      for (const p of [...link.raw.values()]) p.reject(new Error('il PC si è scollegato'));
      // I ponti SSH passano da questo collegamento: si chiudono con lui.
      link.bridges.stop(`il PC "${device.name}" si è scollegato`);
      if (links.get(device.id) === link) {
        links.delete(device.id);
        deviceStore.seen(device.id, null, null);
        // Gli strumenti restano nell'elenco (rispondono «PC non collegato»): niente da far rileggere.
        publish();
        app.log.info(`Companion scollegato: ${device.name}`);
      }
    });
    publish();
  });

  // Ping regolare: chi non risponde viene chiuso (il companion si ricollega da solo).
  // Anche un messaggio companion/ping, perché non tutti i client WebSocket segnalano i ping del protocollo.
  setInterval(() => {
    for (const link of links.values()) {
      if (!link.alive) { link.socket.terminate(); continue; }
      link.alive = false;
      link.socket.ping();
      send(link, { jsonrpc: '2.0', method: 'companion/ping' });
    }
  }, PING_MS).unref();

  bus.on((ev) => { if (ev.type === 'message') notifyPcs(ev.message); });

  // Versione nuova pubblicata mentre i PC sono collegati: la scoprono entro 10 minuti.
  setInterval(() => { for (const link of links.values()) offerUpdate(link); }, 10 * 60_000).unref();
  // Appena pubblicata (fetch-release.sh e publish.sh scrivono companion.json per ultimo): la si offre subito.
  fs.watchFile(path.join(downloadsDir(), 'companion.json'), { interval: 5000 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) for (const link of links.values()) offerUpdate(link);
  }).unref();

  // File dell'aggiornamento, solo per i dispositivi registrati e solo quelli elencati in companion.json.
  app.get<{ Params: { file: string } }>(`${COMPANION_DOWNLOAD_PATH}/:file`, { preValidation: deviceAuth }, async (req, reply) => {
    const abs = path.join(downloadsDir(), path.basename(req.params.file));
    if (!listed('companion.json', req.params.file) || !fs.existsSync(abs)) return reply.code(404).send({ error: 'non trovato' });
    reply.header('Content-Length', fs.statSync(abs).size);
    return reply.type('application/octet-stream').send(fs.createReadStream(abs));
  });

  // File dal repo al PC (scarica_da_ciccio): solo il file preparato per quel token, una volta.
  app.get<{ Params: { token: string } }>(`${COMPANION_TRANSFER_PATH}/:token`, { preValidation: deviceAuth }, async (req, reply) => {
    const device = deviceOf.get(req)!;
    const t = takeTransfer(req.params.token, 'download', device);
    if (!t) return reply.code(404).send({ error: 'trasferimento sconosciuto, già usato o scaduto' });
    // Il file controllato alla preparazione, aperto senza seguire collegamenti: niente nuovo giro sul percorso.
    const fd = openPrepared(t);
    if (fd === null) return reply.code(404).send({ error: 'il file non c\'è più' });
    if (typeof fd === 'string') return reply.code(409).send({ error: fd });
    const size = fs.fstatSync(fd).size;
    app.log.info(`File al PC ${device.name}: ${t.rel} (${size} byte, ${t.who})`);
    reply.header('Content-Length', size);
    return reply.type('application/octet-stream').send(fs.createReadStream(t.abs, { fd }));
  });

  // File dal PC al repo (carica_su_ciccio): il corpo va solo nella destinazione preparata per quel token.
  void app.register(async (sub) => {
    sub.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    sub.put<{ Params: { token: string } }>(`${COMPANION_TRANSFER_PATH}/:token`, { preValidation: deviceAuth }, async (req, reply) => {
      const device = deviceOf.get(req)!;
      const t = takeTransfer(req.params.token, 'upload', device);
      if (!t) return reply.code(404).send({ error: 'trasferimento sconosciuto, già usato o scaduto' });
      if (Number(req.headers['content-length'] ?? 0) > MAX_TRANSFER_BYTES) return reply.code(413).send({ error: `file troppo grande (massimo ${MAX_TRANSFER_BYTES} byte)` });
      // Di nuovo adesso: nel frattempo nel repo può essere comparso un collegamento o un file.
      const target = uploadTarget(t.repo, t.rel, t.overwrite);
      if (typeof target === 'string' || target.abs !== t.abs) return reply.code(409).send({ error: typeof target === 'string' ? target : 'la destinazione è cambiata' });
      const body = req.body as Readable | undefined;
      if (!body || typeof body[Symbol.asyncIterator] !== 'function') return reply.code(400).send({ error: 'serve il contenuto del file (application/octet-stream)' });
      fs.mkdirSync(path.dirname(t.abs), { recursive: true });
      if (!insideDir(t.repo, realLoose(path.dirname(t.abs)))) return reply.code(409).send({ error: 'la destinazione esce dal repo' });
      const tmp = path.join(path.dirname(t.abs), `.${path.basename(t.abs)}.ciccio-${randomBytes(4).toString('hex')}`);
      const h = createHash('sha256');
      let n = 0;
      const fd = fs.openSync(tmp, 'wx', 0o644);
      try {
        for await (const chunk of body as AsyncIterable<Buffer>) {
          n += chunk.length;
          if (n > MAX_TRANSFER_BYTES) { body.destroy(); throw Object.assign(new Error(`file troppo grande (massimo ${MAX_TRANSFER_BYTES} byte)`), { status: 413 }); }
          h.update(chunk);
          fs.writeSync(fd, chunk);
        }
        fs.closeSync(fd);
        fs.renameSync(tmp, t.abs);
      } catch (e) {
        try { fs.closeSync(fd); } catch { /* già chiuso */ }
        fs.rmSync(tmp, { force: true });
        return reply.code((e as { status?: number }).status ?? 500).send({ error: (e as Error).message });
      }
      app.log.info(`File dal PC ${device.name}: ${t.rel} (${n} byte, ${t.who})`);
      return { percorso: t.rel, dimensione: n, sha256: h.digest('hex') };
    });
  });

  app.get('/api/companions', async () => companions());

  const newToken = () => `ccp_${randomBytes(32).toString('base64url')}`;

  /**
   * Token nuovo per un dispositivo già registrato: il PC che usava quello vecchio viene scollegato
   * e non rientra più. Serve quando l'abbinamento non è arrivato al PC (link rifiutato dal browser,
   * companion non ancora installato) o quando lo stesso nome passa a un altro PC.
   */
  const reissue = (device: DeviceRow) => {
    const token = newToken();
    deviceStore.retoken(device.id, sha(token));
    links.get(device.id)?.socket.close(4001, 'dispositivo collegato di nuovo da un altro PC');
    publish();
    return { device: companions().find((c) => c.id === device.id), token, server: mainOrigin };
  };

  // Nuovo dispositivo: il token si vede una volta sola, qui; nel database resta solo l'hash.
  app.post<{ Body: { name?: string } }>('/api/companions', async (req, reply) => {
    const name = (req.body?.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
    if (!name) return reply.code(400).send({ error: 'Dai un nome al dispositivo (lettere e cifre, es. mac).' });
    const existing = deviceStore.byName(name);
    // Mai collegato: l'abbinamento di prima non è arrivato al PC, si riprova con lo stesso dispositivo.
    if (existing && existing.last_seen == null) return reissue(existing);
    if (existing) return reply.code(409).send({ error: `Esiste già un PC «${name}» che si è collegato: dai un altro nome a questo, oppure scollega «${name}» prima.` });
    const token = newToken();
    const id = `d${randomBytes(6).toString('hex')}`;
    deviceStore.add(id, name, sha(token));
    publish();
    return { device: companions().find((c) => c.id === id), token, server: mainOrigin };
  });

  // «Collega questo PC» dalla scheda di un dispositivo: token nuovo per quel nome.
  app.post<{ Params: { id: string } }>('/api/companions/:id/token', async (req, reply) => {
    const device = deviceStore.all().find((d) => d.id === req.params.id);
    if (!device) return reply.code(404).send({ error: 'Dispositivo non trovato.' });
    return reissue(device);
  });

  // Toglie il dispositivo: il token smette di valere e il collegamento aperto si chiude.
  // Procedura guidata di Chrome: apre un sito nel Chrome dedicato del PC (per accedere ai siti
  // che servono agli agenti) o lo prova. Solo queste due azioni, chieste dall'utente dalla pagina.
  app.post<{ Params: { id: string }; Body: { action?: 'open' | 'test'; url?: string } }>('/api/companions/:id/chrome', async (req, reply) => {
    const link = links.get(req.params.id);
    if (!link) return reply.code(409).send({ error: 'Il PC non è collegato in questo momento.' });
    const chrome = link.servers.find((x) => x.status === 'online' && x.tools.some((t) => t.name === 'new_page' || t.name === 'list_pages'));
    if (!chrome) return reply.code(409).send({ error: 'Chrome non è pronto su questo PC.' });
    if (req.body?.action === 'open') {
      let url = (req.body.url ?? '').trim() || 'https://accounts.google.com';
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      try { new URL(url); } catch { return reply.code(400).send({ error: 'Indirizzo non valido.' }); }
      const r = await callOnPc(link, { server: chrome.name, name: 'new_page', arguments: { url } });
      return { ok: !r.isError, text: resultText(r) };
    }
    const r = await callOnPc(link, { server: chrome.name, name: 'list_pages', arguments: {} });
    return { ok: !r.isError, text: resultText(r) };
  });

  // Ponti SSH (Configurazione › Server SSH): proporne uno al PC, che chiede nella sua finestra, o toglierlo.
  // Ciccio può solo chiedere: la voce la scrive il PC, e solo dopo il «Consenti» di chi è lì.
  app.post<{ Params: { id: string }; Body: { action?: string; host?: string } }>('/api/companions/:id/ssh-bridges', async (req, reply) => {
    const link = linkOf(req.params.id);
    if (!link) return reply.code(409).send({ error: 'Il PC non è collegato in questo momento.' });
    const t = parseBridgeTarget(String(req.body?.host ?? ''));
    if (!t) return reply.code(400).send({ error: 'Scrivi host o host:porta (nome o IPv4), es. 192.168.1.50:22.' });
    try {
      if (req.body?.action === 'propose') {
        // La finestra sul PC aspetta fino a 2 minuti.
        const r = await request(link, SSH_BRIDGE_PROPOSE, { host: t.host, port: t.port }, 150_000) as { esito?: unknown };
        const esito: BridgeProposal = r?.esito === 'consentito' || r?.esito === 'già' || r?.esito === 'rifiutato' ? r.esito : 'nessuna_risposta';
        app.log.info(`Ponte SSH proposto al PC ${link.device.name}: ${t.key} → ${esito}`);
        return { esito, pc: link.device.name, target: t.key };
      }
      if (req.body?.action === 'remove') {
        const r = await request(link, SSH_BRIDGE_REMOVE, { host: t.host, port: t.port }, 20_000) as { tolto?: unknown };
        app.log.info(`Ponte SSH tolto dal PC ${link.device.name}: ${t.key}`);
        return { tolto: r?.tolto === true, pc: link.device.name, target: t.key };
      }
    } catch (e) {
      return reply.code(502).send({ error: `Il PC "${link.device.name}" ha risposto: ${(e as Error).message}` });
    }
    return reply.code(400).send({ error: 'azione non valida' });
  });

  app.post<{ Params: { id: string } }>('/api/companions/:id/remove', async (req) => {
    const link = links.get(req.params.id);
    deviceStore.remove(req.params.id);
    if (link) link.socket.close(4001, 'dispositivo rimosso');
    publish();
    return { ok: true };
  });
}
