import os from 'node:os';
import WebSocket from 'ws';
import { COMPANION_PATH, COMPANION_PROTOCOL, SECRET_READ_METHOD, SSH_AGENT_METHOD, type CallParams, type HelloParams, type NotifyParams, type RpcId, type UpdateParams } from '../../shared/companion.js';
import { onePasswordFeatures, readSecret, sshAgentRequest } from './onepassword.js';
import { OnePasswordGuard } from './consensi.js';
import fs from 'node:fs';
import path from 'node:path';
import { notifyDir, VERSION } from './config.js';
import type { LocalServer } from './local.js';
import { dim, green, log, red, yellow } from './log.js';
import { setStatus } from './status.js';
import { Updater } from './update.js';
import { UsageReporter } from './consumi.js';

const MAX_BACKOFF_MS = 30_000;
/** Ciccio manda un segnale ogni 30 s: se per 75 s non arriva niente, il collegamento è morto. */
const SILENCE_MS = 75_000;
/** Token rifiutato o dispositivo rimosso: inutile insistere, si riprova di rado. */
const REJECTED_RETRY_MS = 5 * 60_000;

/**
 * Collegamento in uscita verso Ciccio (wss://…/companion): inoltra le chiamate agli strumenti
 * ai server MCP locali e tiene Ciccio aggiornato su cosa è disponibile. Si ricollega da solo.
 */
export class CiccioLink {
  private ws: WebSocket | null = null;
  private backoff = 1000;
  private silence: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private calls = new Map<RpcId, AbortController>();
  private stopped = false;
  private rejected = false;
  /** Ultimo problema scritto: lo stesso errore a ogni tentativo si scrive una volta sola. */
  private problem = '';
  private updater: Updater;
  private usage = new UsageReporter((msg) => this.send(msg));

  /** `guard`: i consensi sul PC per 1Password (consensi.ts); di base solo finestre, senza elenco nella config. */
  constructor(private serverUrl: string, private token: string, private servers: Map<string, LocalServer>, private notifications = false, private guard = new OnePasswordGuard(null)) {
    this.updater = new Updater(serverUrl, token, () => this.calls.size > 0);
    for (const s of servers.values()) this.attach(s);
    setStatus({ server: serverUrl });
    this.publishServers();
    // 1Password attivato (o spento) a companion acceso: Ciccio lo sa entro un minuto, senza ricollegarsi.
    let op = JSON.stringify(onePasswordFeatures());
    setInterval(() => {
      const now = JSON.stringify(onePasswordFeatures());
      if (now !== op) { op = now; this.send({ jsonrpc: '2.0', method: 'companion/onepassword', params: JSON.parse(now) }); }
    }, 60_000).unref();
  }

  /** Un server nuovo nella mappa (config ricaricata): Ciccio saprà dei suoi cambiamenti. */
  attach(s: LocalServer) {
    s.on('change', () => this.serversChanged());
  }

  /** I server della mappa sono cambiati (aggiunti, tolti o con strumenti nuovi): lo si dice a Ciccio. */
  serversChanged() {
    this.sendServers();
    this.publishServers();
  }

  private publishServers() {
    setStatus({ servers: this.states().map((s) => ({ name: s.name, status: s.status, tools: s.tools.length, error: s.error })) });
  }

  private get url(): string {
    const u = new URL(COMPANION_PATH, this.serverUrl);
    u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    return u.toString();
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.retry);
    const ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.token}` }, handshakeTimeout: 15_000, maxPayload: 64 * 1024 * 1024 });
    this.ws = ws;
    this.rejected = false;
    let opened = false;
    ws.on('open', () => {
      opened = true;
      this.problem = '';
      this.backoff = 1000;
      this.alive();
      const hello: HelloParams = { protocol: COMPANION_PROTOCOL, version: VERSION, platform: `${os.platform()}-${os.arch()}`, servers: this.states(), notifications: this.notifications, onePassword: onePasswordFeatures() };
      this.send({ jsonrpc: '2.0', method: 'companion/hello', params: hello });
    });
    ws.on('ping', () => this.alive());
    ws.on('message', (raw) => { this.alive(); this.onMessage(raw.toString()); });
    ws.on('error', (err) => { if (opened) log(`${yellow('○')} collegamento a Ciccio: ${err.message}`); });
    ws.on('close', async (code, reason) => {
      clearTimeout(this.silence);
      if (this.ws !== ws) return;
      setStatus({ connected: false });
      if (!opened) await this.whyRefused();
      this.ws = null;
      for (const c of this.calls.values()) c.abort();
      this.calls.clear();
      if (this.stopped) return;
      if (code === 4001) { this.rejected = true; setStatus({ rejected: true, problem: reason.toString() || 'dispositivo rimosso' }); log(`${red('✗')} Ciccio ha chiuso: ${reason.toString() || 'dispositivo rimosso'}`); }
      else if (code === 4000) log(`${yellow('○')} un altro companion con lo stesso token si è collegato a Ciccio`);
      // Sostituito da un altro companion con lo stesso token: si aspetta un minuto, così non si scalzano a vicenda.
      const wait = this.rejected ? REJECTED_RETRY_MS : code === 4000 ? 60_000 : this.backoff;
      if (!this.rejected) this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      if (opened || this.rejected) log(dim(`${opened ? 'scollegato da Ciccio' : 'non collegato'} · riprovo tra ${Math.round(wait / 1000)} s`));
      // Un po' di casualità: se il server riparte, i PC non si ricollegano tutti nello stesso istante.
      this.retry = setTimeout(() => this.connect(), wait + Math.random() * 500);
    });
  }

  /**
   * La WebSocket non si è aperta: una richiesta HTTP normale dice perché (Bun non espone lo stato
   * della risposta all'handshake). 401/403 = token sbagliato o dispositivo rimosso.
   */
  private async whyRefused() {
    try {
      const res = await fetch(this.url.replace(/^ws/, 'http'), { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 401 || res.status === 403) {
        this.rejected = true;
        this.report(`${red('✗')} Ciccio ha rifiutato il token (HTTP ${res.status}): genera un nuovo dispositivo in Ciccio › Impostazioni › Companion e rifai init.`);
      } else {
        this.report(`${yellow('○')} Ciccio non ha accettato il collegamento (HTTP ${res.status})`);
      }
    } catch (err) {
      const e = err as Error;
      this.report(`${yellow('○')} Ciccio non raggiungibile: ${e.cause instanceof Error ? e.cause.message : e.message}`);
    }
  }

  private report(line: string) {
    if (line !== this.problem) log(line);
    this.problem = line;
    setStatus({ problem: line, rejected: this.rejected });
  }

  private alive() {
    clearTimeout(this.silence);
    this.silence = setTimeout(() => { log(yellow('○ nessun segnale da Ciccio da 75 s, mi ricollego')); this.ws?.terminate(); }, SILENCE_MS);
  }

  private states() {
    return [...this.servers.values()].map((s) => s.state);
  }

  private sendServers() {
    this.send({ jsonrpc: '2.0', method: 'companion/servers', params: { servers: this.states() } });
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(raw: string) {
    let msg: { id?: RpcId; method?: string; params?: unknown };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.method === 'companion/welcome') {
      const p = msg.params as { device?: string; mcpName?: string };
      setStatus({ connected: true, device: p.device ?? null, problem: '', rejected: false });
      log(`${green('●')} collegato a ${new URL(this.serverUrl).host} come "${p.device}" ${dim(`(strumenti mcp__${p.mcpName}__…)`)}`);
      this.usage.start();
      return;
    }
    if (msg.method === 'companion/update') { this.updater.offer(msg.params as UpdateParams); return; }
    if (msg.method === 'companion/notify') { if (this.notifications) queueNotification(msg.params as NotifyParams); return; }
    if (msg.method === 'notifications/cancelled') {
      const id = (msg.params as { requestId?: RpcId })?.requestId;
      if (id != null) this.calls.get(id)?.abort();
      return;
    }
    if (msg.method === 'tools/call' && msg.id != null) void this.call(msg.id, msg.params as CallParams);
    if ((msg.method === SSH_AGENT_METHOD || msg.method === SECRET_READ_METHOD) && msg.id != null) void this.onePassword(msg.id, msg.method, msg.params);
  }

  /**
   * Richieste a 1Password: firma SSH o lettura di un segreto. Prima decide il PC (consensi.ts): l'approvazione
   * in Ciccio da sola non basta. Nel registro va cosa, mai il valore.
   */
  private async onePassword(id: RpcId, method: string, params: unknown) {
    const ctrl = new AbortController();
    this.calls.set(id, ctrl);
    const p = (params ?? {}) as { message?: unknown; ref?: unknown; bind?: unknown; motivo?: unknown };
    try {
      if (method === SSH_AGENT_METHOD) {
        const req = Buffer.from(typeof p.message === 'string' ? p.message : '', 'base64');
        const signing = req[4] === 13;
        if (signing) {
          const bind = typeof p.bind === 'string' ? Buffer.from(p.bind, 'base64') : null;
          log(`→ 1Password · firma SSH per ${await this.guard.approveSsh(req, bind, ctrl.signal)}`);
        }
        const res = await sshAgentRequest(req, ctrl.signal);
        if (signing) log(`← 1Password · firma SSH ${res[4] === 14 ? green('ok') : red('rifiutata')}`);
        this.send({ jsonrpc: '2.0', id, result: { message: res.toString('base64') } });
      } else {
        const ref = typeof p.ref === 'string' ? p.ref : '';
        await this.guard.approveSecret(ref, typeof p.motivo === 'string' ? p.motivo : undefined, ctrl.signal);
        log(`→ 1Password · lettura ${ref}`);
        const value = await readSecret(ref, ctrl.signal);
        log(`← 1Password · ${green('letto')} ${dim('(il valore va solo a Ciccio)')}`);
        this.send({ jsonrpc: '2.0', id, result: { value } });
      }
    } catch (err) {
      const message = ctrl.signal.aborted ? 'richiesta annullata' : (err as Error).message;
      log(`← 1Password · ${red(message)}`);
      this.send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
    } finally {
      this.calls.delete(id);
    }
  }

  private async call(id: RpcId, p: CallParams) {
    const server = p && this.servers.get(p.server);
    if (!server) { this.send({ jsonrpc: '2.0', id, error: { code: -32602, message: `server ${p?.server} non configurato sul PC` } }); return; }
    const ctrl = new AbortController();
    this.calls.set(id, ctrl);
    const t0 = Date.now();
    log(`→ ${p.server} · ${p.name}`);
    try {
      const result = await server.call(p.name, p.arguments, ctrl.signal, p.transfer);
      setStatus({ lastCall: { server: p.server, name: p.name, ok: !result.isError, at: Date.now() } });
      log(`← ${p.server} · ${p.name} ${result.isError ? red('errore') : green('ok')} ${dim(`${((Date.now() - t0) / 1000).toFixed(1)} s`)}`);
      this.send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      const message = ctrl.signal.aborted ? 'chiamata interrotta' : (err as Error).message;
      log(`← ${p.server} · ${p.name} ${red(message)}`);
      this.send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
    } finally {
      this.calls.delete(id);
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.silence);
    this.usage.stop();
    this.ws?.close(1000, 'companion chiuso');
  }
}

/** Lascia la notifica all'app dell'icona: un file per notifica, scritto in modo atomico; al massimo 20 in attesa. */
function queueNotification(n: NotifyParams) {
  if (!n || typeof n.title !== 'string' || typeof n.body !== 'string' || typeof n.url !== 'string' || !/^https?:\/\//.test(n.url)) return;
  try {
    const dir = notifyDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${String(n.id).replace(/[^\w-]/g, '').slice(0, 24) || 'n'}.json`;
    fs.writeFileSync(path.join(dir, `${name}.tmp`), JSON.stringify({ id: n.id, title: n.title.slice(0, 120), body: n.body.slice(0, 400), url: n.url, tone: n.tone }));
    fs.renameSync(path.join(dir, `${name}.tmp`), path.join(dir, name));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 20))) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* una notifica persa non deve fermare il companion */ }
}
