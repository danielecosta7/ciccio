import { EventEmitter } from 'node:events';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createFileServer, type FileServerOptions } from './file.js';
import { createCommandsServer, type CommandsServerOptions } from './comandi.js';
import { expandPath, toolAllowed, VERSION, type ServerEntry } from './config.js';
import { readSecret } from './onepassword.js';
import { OP_REF, TRANSFER_META, type LocalServerState, type LocalTool, type TransferParams } from '../../shared/companion.js';
import { dim, green, log, yellow } from './log.js';
import { detachChrome, ensureChrome, type DetachedChrome } from './chrome-mac.js';

const RETRY_MS = 30_000;
/** 1Password non ha dato una chiave (annullato, bloccato): si richiede di rado, ogni richiesta è una finestra sul PC. */
const SECRET_RETRY_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 10 * 60_000;

/** Opzioni dei server integrati: «file» (chiedi_accesso, trasferimenti) e «comandi» (proposte). */
export interface BuiltinOptions { file?: FileServerOptions; comandi?: CommandsServerOptions }

class SecretError extends Error {}
/** Chiavi lette da 1Password (op://…) per env e intestazioni: solo in memoria, una lettura per avvio del companion. */
const secrets = new Map<string, string>();
let secretReader: (ref: string) => Promise<string> = (ref) => readSecret(ref);
/** Prove: chi legge i riferimenti op:// al posto della CLI di 1Password. */
export function setSecretReader(f: (ref: string) => Promise<string>) { secretReader = f; secrets.clear(); }

/** I valori op://… sostituiti con la chiave letta da 1Password; gli altri come sono. */
async function withSecrets(vars: Record<string, string> | undefined): Promise<Record<string, string> | undefined> {
  if (!vars) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (!OP_REF.test(v)) { out[k] = v; continue; }
    let value = secrets.get(v);
    if (value === undefined) {
      try { value = await secretReader(v); } catch (e) { throw new SecretError(`1Password non ha dato ${k} (${v}): ${(e as Error).message}`); }
      secrets.set(v, value);
    }
    out[k] = value;
  }
  return out;
}

/**
 * Un server MCP del PC (Affinity, Chrome…): il companion ne è il client.
 * Se non risponde (app chiusa, comando che esce) riprova da solo ogni 30 secondi.
 */
export class LocalServer extends EventEmitter {
  state: LocalServerState;
  private client: Client | null = null;
  private stdio: StdioClientTransport | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stderrTail = '';
  private stopped = false;
  private lastError = '';
  /** Sul Mac, Chrome aperto a parte (vedi chrome-mac.ts): si apre alla prima chiamata. */
  private chrome: DetachedChrome | null = null;
  private chromeUsed = false;
  private builtin: McpServer | null = null;

  /** `builtin`: finestre sul PC, salvataggio nella config e trasferimenti dei server integrati. */
  constructor(readonly name: string, readonly entry: ServerEntry, private builtinOptions: BuiltinOptions = {}) {
    super();
    this.state = { name, status: 'offline', tools: [] };
  }

  private async transport(): Promise<Transport> {
    const e = this.entry;
    if ('builtin' in e) {
      // Server integrato: client e server nello stesso processo, collegati in memoria.
      const [client, server] = InMemoryTransport.createLinkedPair();
      // Cartelle o comandi cambiati (chiedi_accesso, proponi_comando): istruzioni nuove a Ciccio, senza ricollegarsi.
      const onChange = (instructions: string) => this.set({ instructions });
      this.builtin = e.builtin === 'file'
        ? createFileServer(e.roots, { ...this.builtinOptions.file, onChange })
        : createCommandsServer(e, { ...this.builtinOptions.comandi, onChange });
      void this.builtin.connect(server);
      return client;
    }
    if ('url' in e) {
      const headers = await withSecrets(e.headers);
      const init = headers ? { requestInit: { headers } } : undefined;
      return e.type === 'sse' ? new SSEClientTransport(new URL(e.url), init) : new StreamableHTTPClientTransport(new URL(e.url), init);
    }
    const env = await withSecrets(e.env);
    let args = (e.args ?? []).map(expandPath);
    const detached = detachChrome(args, expandPath('~/.ciccio-companion/chrome-profile'));
    if (detached) { args = detached.args; this.chrome = detached.chrome; }
    const t = new StdioClientTransport({
      command: e.command,
      args,
      env: { ...getDefaultEnvironment(), ...Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, OP_REF.test(e.env?.[k] ?? '') ? v : expandPath(v)])) },
      cwd: e.cwd ? expandPath(e.cwd) : undefined,
      stderr: 'pipe',
    });
    this.stdio = t;
    // Gli ultimi messaggi di errore del processo servono a spiegare perché non parte.
    t.stderr?.on('data', (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-2000); });
    return t;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    clearTimeout(this.retry);
    const client = new Client({ name: 'ciccio-companion', version: VERSION });
    client.onclose = () => {
      if (this.client !== client) return;
      this.client = null;
      this.set({ status: 'offline', error: 'scollegato', tools: [] });
      this.scheduleRetry();
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { void this.refresh(); });
    try {
      await client.connect(await this.transport(), { timeout: 20_000 });
      this.client = client;
      this.state.instructions = client.getInstructions();
      await this.refresh();
      this.lastError = '';
    } catch (err) {
      await client.close().catch(() => undefined);
      const detail = this.stderrTail.trim().split('\n').pop() ?? '';
      const msg = `${(err as Error).message}${detail ? ` · ${detail}` : ''}`.slice(0, 300);
      this.set({ status: 'offline', error: msg, tools: [] });
      const secret = err instanceof SecretError;
      // Lo stesso errore a ogni tentativo si scrive una volta sola (es. Affinity chiuso).
      if (msg !== this.lastError) log(`${yellow('○')} ${this.name}: non disponibile (${msg}) · riprovo ogni ${secret ? '10 minuti' : '30 s'}`);
      this.lastError = msg;
      this.scheduleRetry(secret ? SECRET_RETRY_MS : RETRY_MS);
    }
  }

  private scheduleRetry(ms = RETRY_MS) {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.start(), ms);
  }

  /** Rilegge l'elenco degli strumenti (tutte le pagine), filtrato con allow/deny della config. */
  private async refresh() {
    if (!this.client) return;
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < 1000);
    // Solo gli strumenti integrati possono dichiararsi trasferimenti di file con Ciccio: un server esterno no.
    const builtin = 'builtin' in this.entry;
    const allowed = tools.filter((t) => toolAllowed(this.entry, t.name)).map((t): LocalTool => ({
      name: t.name, title: t.title, description: t.description,
      inputSchema: t.inputSchema as LocalTool['inputSchema'], annotations: t.annotations,
      ...(builtin && t._meta?.[TRANSFER_META] ? { _meta: { [TRANSFER_META]: t._meta[TRANSFER_META] } } : {}),
    }));
    this.set({ status: 'online', error: undefined, tools: allowed });
    log(`${green('●')} ${this.name}: ${allowed.length} strumenti${allowed.length < tools.length ? dim(` (${tools.length - allowed.length} esclusi dalla config)`) : ''}`);
  }

  private set(patch: Partial<LocalServerState>) {
    this.state = { ...this.state, ...patch };
    this.emit('change');
  }

  /** `transfer`: il file preparato da Ciccio, che arriva solo agli strumenti integrati (mai a un server esterno). */
  async call(name: string, args: Record<string, unknown> | undefined, signal: AbortSignal, transfer?: TransferParams): Promise<CallToolResult> {
    if (!this.client || this.state.status !== 'online') throw new Error(`${this.name} non è disponibile sul PC in questo momento`);
    if (!this.state.tools.some((t) => t.name === name)) throw new Error(`strumento ${name} non esposto da ${this.name}`);
    if (this.chrome) {
      // Chrome chiuso nel frattempo: si riapre, e il server MCP si ricollega da capo al nuovo Chrome.
      if ((await ensureChrome(this.chrome)) && this.chromeUsed) await this.reconnect();
      this.chromeUsed = true;
      if (!this.client) throw new Error(`${this.name} non è disponibile sul PC in questo momento`);
    }
    const meta = transfer && 'builtin' in this.entry ? { _meta: { [TRANSFER_META]: transfer } } : {};
    return (await this.client.callTool({ name, arguments: args, ...meta }, undefined, { signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true })) as CallToolResult;
  }

  /** Chiude e riapre il collegamento con il server MCP locale (stessi strumenti). */
  private async reconnect() {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => undefined);
    await this.start();
  }

  async stop() {
    this.stopped = true;
    this.removeAllListeners('change');
    clearTimeout(this.retry);
    const c = this.client;
    this.client = null;
    if (process.platform === 'win32' && this.stdio) await endTree(this.stdio);
    await c?.close().catch(() => undefined);
    await this.builtin?.close().catch(() => undefined);
  }
}

/**
 * Su Windows un comando come npx parte dentro cmd.exe: chiudere solo cmd lascerebbe orfani il server
 * (node) e i suoi figli. Prima si chiude l'input, così il server esce da solo; se dopo 3 s c'è ancora,
 * si chiude tutto l'albero dei processi.
 */
async function endTree(t: StdioClientTransport) {
  const pid = t.pid;
  // L'SDK non espone il processo: serve il suo stdin per una chiusura pulita.
  const child = (t as unknown as { _process?: ChildProcess })._process;
  if (!pid || !child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try { child.stdin?.end(); } catch { /* già chiuso */ }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  if (child.exitCode === null) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* già chiuso */ }
  }
}
