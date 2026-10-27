import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { config } from './config.js';
import { desktopStore, deviceStore, store, type DesktopAppRow } from './db.js';
import { bus } from './bus.js';
import { failed, limited, sha, startSession } from './auth.js';
import { answerQuestion, decideApproval } from './agents.js';
import { newerVersion } from '../../shared/companion.js';
import { downloadsDir, listed, updateFor } from './releases.js';
import { DESKTOP_DOWNLOAD_PATH, DESKTOP_LOGIN_PATH, DESKTOP_PAIR_PATH, DESKTOP_PATH, DESKTOP_SESSION_PATH, type DesktopNotify } from '../../shared/desktop.js';
import { ASK_TOOL, questionsOf, type Approval, type ChatMessage, type DesktopAppView } from '../../shared/types.js';

// App desktop «Ciccio» (desktop/): una finestra con Ciccio e le notifiche native, con Consenti e Rifiuta
// per i permessi e le domande a due scelte. Protocollo e collegamento: shared/desktop.ts.

const PING_MS = 30_000;
const PAIR_MS = 10 * 60_000;
const LOGIN_CODE_MS = 2 * 60_000;

interface AppLink {
  app: DesktopAppRow;
  socket: WebSocket;
  platform: string | null;
  version: string | null;
  /** Companion dello stesso PC (id del dispositivo): finché l'app è collegata, le notifiche le mostra lei. */
  companionId: string | null;
  alive: boolean;
}

/** App collegate adesso, per id. */
const links = new Map<string, AppLink>();
let log: FastifyBaseLogger | null = null;

export function desktopApps(): DesktopAppView[] {
  const devices = deviceStore.all();
  return desktopStore.all().map((a) => {
    const l = links.get(a.id);
    return {
      id: a.id, name: a.name, online: !!l, platform: l?.platform ?? a.platform, version: l?.version ?? a.version,
      createdAt: a.created_at, lastSeen: l ? Date.now() : a.last_seen,
      companion: l?.companionId ? devices.find((d) => d.id === l.companionId)?.name ?? null : null,
    };
  });
}

function publish() {
  bus.emit({ type: 'desktopApps', apps: desktopApps() });
}

/** Il companion di questo PC non mostra le notifiche: c'è l'app accesa sullo stesso PC. */
export function coveredByApp(deviceId: string): boolean {
  for (const l of links.values()) if (l.companionId === deviceId) return true;
  return false;
}

function send(link: AppLink, msg: unknown) {
  if (link.socket.readyState === link.socket.OPEN) link.socket.send(JSON.stringify(msg));
}

function broadcast(method: string, params: unknown) {
  for (const l of links.values()) send(l, { jsonrpc: '2.0', method, params });
}

// ── Notifiche ───────────────────────────────────────────────────────────

/** Permesso o domanda ancora in attesa, con i pulsanti della notifica; null se va decisa in chat. */
function buttonsFor(a: Approval): { allow: string; deny: string } | null {
  if (a.tool !== ASK_TOOL) return { allow: 'Consenti', deny: 'Rifiuta' };
  // Domande: solo una, a scelta singola e con due risposte brevi (sì/no e simili). Le altre si aprono in chat.
  const qs = questionsOf(a);
  if (qs?.length !== 1 || qs[0].multiSelect || qs[0].options.length !== 2) return null;
  const [allow, deny] = qs[0].options.map((o) => o.label.trim());
  return allow && deny && allow.length <= 24 && deny.length <= 24 ? { allow, deny } : null;
}

const pendingApproval = (id: string, chatId?: string) => store.pendingApprovals(chatId).find((a) => a.id === id);

/** Un avviso di Ciccio diventa una notifica dell'app; per i permessi con Consenti e Rifiuta. */
function notifyApps(m: ChatMessage) {
  if (m.meta?.kind !== 'notice' || !links.size) return;
  const meta = m.meta;
  const agent = store.agent(meta.agentId);
  const pending = meta.approvalId ? pendingApproval(meta.approvalId, meta.chatId) : undefined;
  const buttons = pending ? buttonsFor(pending) : null;
  const params: DesktopNotify = {
    id: String(m.id),
    title: `Ciccio · ${agent?.display_name?.trim() || meta.agentId}`,
    // Con i pulsanti non serve dire di decidere nella chat.
    body: (buttons ? m.text.replace(/\s*Decidi nella chat\.\s*$/, '') : m.text).slice(0, 400),
    path: `/agente/${encodeURIComponent(meta.agentId)}/${encodeURIComponent(meta.chatId)}`,
    tone: meta.tone,
    ...(pending && buttons ? { approval: { id: pending.id, ...buttons } } : {}),
  };
  broadcast('desktop/notify', params);
}

/** Decisione dal pulsante di una notifica. Mai «Consenti sempre»: quello resta nella chat. */
function decide(link: AppLink, approvalId: string, allow: boolean): { ok: boolean; text: string } {
  const a = pendingApproval(approvalId);
  if (!a) return { ok: false, text: 'Non è più in attesa: forse hai già risposto altrove.' };
  const buttons = buttonsFor(a);
  if (!buttons) return { ok: false, text: 'Questa si decide nella chat.' };
  let ok: boolean;
  if (a.tool === ASK_TOOL) {
    const q = questionsOf(a)![0];
    ok = answerQuestion(a.id, { [q.question]: allow ? buttons.allow : buttons.deny });
  } else {
    ok = decideApproval(a.id, allow, false);
  }
  if (ok) log?.info(`App ${link.app.name}: ${allow ? buttons.allow : buttons.deny} · ${a.summary.split('\n')[0].slice(0, 200)}`);
  return ok ? { ok, text: allow ? buttons.allow : buttons.deny } : { ok, text: 'Non è più in attesa.' };
}

// ── Aggiornamento automatico ────────────────────────────────────────────

/** Ultima versione dell'app (downloads/app.json e la sua firma, vedi releases.ts): l'app controlla le firme. */
function offerUpdate(link: AppLink) {
  const params = updateFor('app.json', DESKTOP_DOWNLOAD_PATH, link.platform, link.version, newerVersion);
  if (params) send(link, { jsonrpc: '2.0', method: 'desktop/update', params });
}

// ── Messaggi dall'app ───────────────────────────────────────────────────

function onMessage(link: AppLink, raw: string) {
  let msg: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  try { msg = JSON.parse(raw) as typeof msg; } catch { return; }
  const params = msg.params ?? {};
  if (msg.method === 'desktop/hello') {
    link.platform = typeof params.platform === 'string' ? params.platform.slice(0, 40) : null;
    link.version = typeof params.version === 'string' ? params.version.slice(0, 40) : null;
    // sha256 del token del companion dello stesso PC: lo stesso hash che il database ha di quel dispositivo.
    const hash = typeof params.companion === 'string' && /^[0-9a-f]{64}$/.test(params.companion) ? params.companion : null;
    link.companionId = hash ? deviceStore.byHash(hash)?.id ?? null : null;
    desktopStore.seen(link.app.id, link.platform, link.version);
    offerUpdate(link);
    publish();
    return;
  }
  if (msg.method === 'desktop/decide' && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
    const r = typeof params.approvalId === 'string' && typeof params.allow === 'boolean'
      ? decide(link, params.approvalId, params.allow)
      : { ok: false, text: 'richiesta non valida' };
    send(link, { jsonrpc: '2.0', id: msg.id, result: r });
  }
}

// ── Collegamento ────────────────────────────────────────────────────────

const newToken = () => `cda_${randomBytes(32).toString('base64url')}`;
const cleanName = (raw: unknown) => (typeof raw === 'string' ? raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) : '') || 'PC';
const cleanPlatform = (raw: unknown) => (typeof raw === 'string' && /^[\w-]{1,40}$/.test(raw) ? raw : null);

function createApp(name: string, platform: string | null): { app: DesktopAppView | undefined; token: string } {
  const token = newToken();
  const id = `a${randomBytes(6).toString('hex')}`;
  desktopStore.add(id, name, sha(token), platform);
  publish();
  return { app: desktopApps().find((a) => a.id === id), token };
}

/** Codice da confermare nel browser: 8 caratteri senza quelli che si confondono (0/O, 1/I). */
function pairCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = [...randomBytes(8)].map((b) => abc[b % abc.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

interface Pairing { code: string; name: string; platform: string | null; expires: number; token?: string }
/** Collegamenti in attesa di conferma, per id segreto (lo conosce solo l'app che l'ha chiesto). */
const pairings = new Map<string, Pairing>();
/** Codici monouso per aprire la finestra: valgono pochi minuti, una volta. */
const loginCodes = new Map<string, { appId: string; expires: number }>();

function sweep() {
  const now = Date.now();
  for (const [k, p] of pairings) if (p.expires < now) pairings.delete(k);
  for (const [k, c] of loginCodes) if (c.expires < now) loginCodes.delete(k);
}

// ── Rotte ───────────────────────────────────────────────────────────────

const appOf = new WeakMap<FastifyRequest, DesktopAppRow>();

async function appAuth(req: FastifyRequest, reply: FastifyReply) {
  if (limited(req)) return reply.code(429).send({ error: 'Troppi tentativi, riprova tra qualche minuto.' });
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const app = token ? desktopStore.byHash(sha(token)) : undefined;
  if (!app) { failed(req); return reply.code(401).send({ error: 'app non collegata' }); }
  appOf.set(req, app);
}

/** Dove tornare dopo l'accesso: solo una pagina di Ciccio (percorso assoluto, niente // né \). */
const safeNext = (raw: unknown) => (typeof raw === 'string' && /^\/(?![/\\])[^\\]*$/.test(raw) ? raw : '/');

export function registerDesktop(app: FastifyInstance) {
  log = app.log;
  app.get(DESKTOP_PATH, { websocket: true, preValidation: appAuth }, (socket, req) => {
    const row = appOf.get(req);
    if (!row) { socket.close(4001, 'non autorizzato'); return; }
    const link: AppLink = { app: row, socket, platform: null, version: null, companionId: null, alive: true };
    // Un collegamento per app: il nuovo sostituisce il vecchio (prima il nuovo, così il «close» del vecchio non lo toglie).
    const old = links.get(row.id);
    links.set(row.id, link);
    old?.socket.close(4000, 'sostituito da un nuovo collegamento');
    desktopStore.seen(row.id, null, null);
    app.log.info(`App collegata: ${row.name}`);
    send(link, { jsonrpc: '2.0', method: 'desktop/welcome', params: { name: row.name } });
    socket.on('pong', () => { link.alive = true; });
    socket.on('message', (raw: Buffer) => { link.alive = true; onMessage(link, raw.toString()); });
    socket.on('close', () => {
      if (links.get(row.id) !== link) return;
      links.delete(row.id);
      desktopStore.seen(row.id, null, null);
      publish();
      app.log.info(`App scollegata: ${row.name}`);
    });
    publish();
  });

  setInterval(() => {
    for (const link of links.values()) {
      if (!link.alive) { link.socket.terminate(); continue; }
      link.alive = false;
      link.socket.ping();
      send(link, { jsonrpc: '2.0', method: 'desktop/ping' });
    }
    sweep();
  }, PING_MS).unref();
  setInterval(() => { for (const link of links.values()) offerUpdate(link); }, 10 * 60_000).unref();
  // Versione appena pubblicata (publish.sh scrive app.json per ultimo): la si offre subito alle app collegate,
  // senza aspettare il giro dei 10 minuti.
  fs.watchFile(path.join(downloadsDir(), 'app.json'), { interval: 5000 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) for (const link of links.values()) offerUpdate(link);
  }).unref();

  bus.on((ev) => {
    if (ev.type === 'message') notifyApps(ev.message);
    // Deciso altrove (chat, telefono, altra app): la notifica con i pulsanti sparisce.
    if (ev.type === 'approval' && ev.approval.status !== 'pending') broadcast('desktop/resolved', { approvalId: ev.approval.id });
  });

  // Codice per aprire la finestra con una sessione, senza passkey.
  app.post(DESKTOP_SESSION_PATH, { preValidation: appAuth }, async (req) => {
    const row = appOf.get(req)!;
    sweep();
    const code = randomBytes(32).toString('base64url');
    loginCodes.set(code, { appId: row.id, expires: Date.now() + LOGIN_CODE_MS });
    return { code, url: `${DESKTOP_LOGIN_PATH}?code=${code}` };
  });

  app.get<{ Querystring: { code?: string; next?: string } }>(DESKTOP_LOGIN_PATH, async (req, reply) => {
    if (limited(req)) return reply.code(429).type('text/plain; charset=utf-8').send('Troppi tentativi, riprova tra qualche minuto.');
    const c = loginCodes.get(req.query.code ?? '');
    loginCodes.delete(req.query.code ?? '');
    const row = c && c.expires > Date.now() ? desktopStore.all().find((a) => a.id === c.appId) : undefined;
    if (!row) { failed(req); return reply.code(400).type('text/plain; charset=utf-8').send('Accesso dell\'app scaduto: chiudi e riapri Ciccio.'); }
    startSession(reply, `App · ${row.name}`, false);
    return reply.redirect(safeNext(req.query.next), 302);
  });

  // Collegamento da internet: l'app chiede un codice e lo mostra; l'utente lo conferma da Impostazioni › App.
  app.post<{ Body: { name?: unknown; platform?: unknown } }>(DESKTOP_PAIR_PATH, async (req, reply) => {
    if (limited(req)) return reply.code(429).send({ error: 'Troppi tentativi, riprova tra qualche minuto.' });
    sweep();
    if (pairings.size >= 20) return reply.code(429).send({ error: 'Troppi collegamenti in attesa, riprova tra qualche minuto.' });
    const id = randomBytes(32).toString('base64url');
    const code = pairCode();
    pairings.set(id, { code, name: cleanName(req.body?.name), platform: cleanPlatform(req.body?.platform), expires: Date.now() + PAIR_MS });
    return { pairId: id, code, minutes: PAIR_MS / 60_000 };
  });

  app.post<{ Body: { pairId?: unknown } }>(`${DESKTOP_PAIR_PATH}/poll`, async (req, reply) => {
    const id = typeof req.body?.pairId === 'string' ? req.body.pairId : '';
    const p = pairings.get(id);
    if (!p || p.expires < Date.now()) return reply.code(404).send({ error: 'Codice scaduto: chiedine uno nuovo dall\'app.' });
    if (!p.token) return { status: 'waiting' };
    pairings.delete(id);
    return { status: 'done', token: p.token, name: p.name };
  });

  // Dal browser, con accesso: conferma il codice mostrato dall'app.
  app.post<{ Body: { code?: unknown } }>('/api/desktop/pair/approve', async (req, reply) => {
    sweep();
    const code = typeof req.body?.code === 'string' ? normCode(req.body.code) : '';
    const entry = [...pairings.values()].find((p) => !p.token && normCode(p.code) === code);
    if (!code || !entry) return reply.code(404).send({ error: 'Codice sconosciuto o scaduto: controlla quello mostrato dall\'app.' });
    const r = createApp(entry.name, entry.platform);
    entry.token = r.token;
    return { app: r.app };
  });

  // Dall'indirizzo Tailscale (o con accesso): l'app crea da sola il suo token.
  app.post<{ Body: { name?: unknown; platform?: unknown } }>('/api/desktop/apps', async (req) => {
    const r = createApp(cleanName(req.body?.name), cleanPlatform(req.body?.platform));
    return { app: r.app, token: r.token };
  });

  app.get('/api/desktop/apps', async () => desktopApps());

  // Toglie l'app: il token smette di valere e il collegamento aperto si chiude.
  app.post<{ Params: { id: string } }>('/api/desktop/apps/:id/remove', async (req) => {
    desktopStore.remove(req.params.id);
    links.get(req.params.id)?.socket.close(4001, 'app scollegata da Ciccio');
    publish();
    return { ok: true };
  });

  // File dell'aggiornamento, solo per le app collegate e solo quelli elencati in app.json.
  app.get<{ Params: { file: string } }>(`${DESKTOP_DOWNLOAD_PATH}/:file`, { preValidation: appAuth }, async (req, reply) => {
    const abs = path.join(downloadsDir(), path.basename(req.params.file));
    if (!listed('app.json', req.params.file) || !fs.existsSync(abs)) return reply.code(404).send({ error: 'non trovato' });
    reply.header('Content-Length', fs.statSync(abs).size);
    return reply.type('application/octet-stream').send(fs.createReadStream(abs));
  });
}
