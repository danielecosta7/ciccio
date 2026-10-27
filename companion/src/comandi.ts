import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { COMMAND_NAME, Command, expandPath, parseServerEntry, prettyError, type CommandEntry, type CommandParam, type CommandsEntry } from './config.js';
import { ACCESS_TIMEOUT_MS, FileError, backupExisting, prepareFileWrite, resolveInside, resolveRoots, type RootSpec } from './file.js';
import type { ConfirmAnswer, ConfirmRequest } from './access.js';
import { OP_REF, serverSlug } from '../../shared/companion.js';

// Server MCP «comandi», integrato nel companion: programmi a riga di comando consentiti dalla config, ognuno
// uno strumento con i suoi parametri tipizzati. Niente «esegui un comando qualsiasi»: programma e argomenti
// sono fissi, l'agente sceglie solo i valori dei segnaposto ({modello}, {uscita}…), che si controllano come
// i percorsi del server «file» (realpath, junction, sola lettura). Si lancia senza shell, con l'elenco degli
// argomenti: nessun valore diventa un comando.
// proponi_comando e proponi_strumento: un agente propone una voce nuova o un server MCP nuovo; sul PC compare
// la finestra con il programma e gli argomenti esatti, e solo «Consenti sempre» lo scrive nella config.

const WIN = process.platform === 'win32';
/** Quanto dell'output torna all'agente (la fine, dove di solito ci sono gli errori). */
const OUTPUT_TAIL = 6000;
const CAPTURE_MAX = 256 * 1024;
/** Dopo un «No», la stessa proposta si rifiuta da sola per questo tempo (niente finestre a raffica). */
const REFUSED_MS = 10 * 60_000;
const RESERVED = new Set(['proponi_comando', 'proponi_strumento']);

const text = (o: unknown, isError = false): CallToolResult => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) }] });
const fail = (e: unknown): CallToolResult => text(e instanceof FileError ? e.message : `Errore: ${(e as NodeJS.ErrnoException).code ?? ''} ${(e as Error).message}`.trim(), true);
const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} secondi` : `${Math.round(ms / 60_000)} minuti`);

// ── Controlli sulle proposte ─────────────────────────────────────────────

/** A capo, caratteri di controllo e inversioni del verso del testo: in una finestra di conferma potrebbero ingannare. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
function visible(s: string, what: string) {
  if (INVISIBLE.test(s)) throw new FileError(`${what}: niente a capo né caratteri invisibili.`);
}
/** Il motivo scritto dall'agente, su una riga e senza caratteri invisibili: si mostra come tale, non conferma niente. */
const reason = (s: string) => s.replace(new RegExp(INVISIBLE.source, 'g'), ' ').replace(/\s+/g, ' ').trim();

/** Nomi di variabili e intestazioni che di solito contengono una chiave. */
const SECRET_NAME = /(key|token|secret|passw|pwd|auth|credential|cookie|session|bearer|private|signature)/i;
const SECRET_VALUE = [
  /\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_/, /\bxox[abprs]-/, /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/, /\bglpat-/, /\bya29\./, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY/,
];
/** Sembra una chiave: un prefisso noto, oppure una lunga sequenza casuale con maiuscole, minuscole e cifre. */
export function looksSecret(v: string): boolean {
  if (SECRET_VALUE.some((r) => r.test(v))) return true;
  return (v.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []).some((w) => /[a-z]/.test(w) && /[A-Z]/.test(w) && /[0-9]/.test(w));
}
const SECRET_FLAG = /^--?[a-z0-9-]*(api[-_]?key|token|secret|passw|pwd|auth)[a-z0-9-]*(=|$)/i;

const NO_PLAIN = 'Le chiavi non si scrivono mai in chiaro nella config: indica il riferimento di 1Password (op://vault/elemento/campo) in env, il companion lo legge all\'avvio (1Password chiede Windows Hello o Touch ID).';

/** Argomenti senza chiavi: né valori che sembrano chiavi, né opzioni come --api-key=… (i riferimenti a 1Password vanno in env). */
function checkArgs(args: string[]) {
  args.forEach((a, i) => {
    visible(a, `Argomento ${i + 1}`);
    if (OP_REF.test(a)) throw new FileError(`Argomento ${i + 1}: i riferimenti a 1Password vanno in env, non negli argomenti.`);
    if (looksSecret(a) || (SECRET_FLAG.test(a) && (/=./.test(a) || i + 1 < args.length))) throw new FileError(`Argomento ${i + 1} («${a.slice(0, 40)}»): sembra una chiave. ${NO_PLAIN}`);
  });
}

/** Valori di env o intestazioni: un riferimento a 1Password, oppure un valore che non è una chiave. */
function checkValues(vars: Record<string, string>, what: string) {
  for (const [k, v] of Object.entries(vars)) {
    visible(k, what); visible(v, `${what} ${k}`);
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(k)) throw new FileError(`${what}: nome non valido «${k}».`);
    if (OP_REF.test(v)) continue;
    if (SECRET_NAME.test(k) || looksSecret(v)) throw new FileError(`${what} ${k}: sembra una chiave. ${NO_PLAIN}`);
  }
}

/** Il programma come lo troverebbe il sistema: percorso assoluto, oppure un nome cercato nel PATH (su Windows con PATHEXT). */
export function findProgram(cmd: string): string | null {
  const c = expandPath(cmd);
  const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (path.isAbsolute(c)) return isFile(c) ? c : null;
  if (/[\\/]/.test(c)) return null;
  const exts = WIN ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) { const p = path.join(dir, c + e); if (isFile(p)) return p; }
  }
  return null;
}

/** Un argomento come lo si scriverebbe in un terminale (solo per mostrarlo). */
const shown = (a: string) => (a === '' || /[\s"'`$&|<>()^;]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

const INTERPRETERS = /^(cmd|powershell|pwsh|bash|sh|zsh|fish|wscript|cscript|mshta|python[0-9.]*|py|node|deno|bun|ruby|perl|php|osascript|rundll32|regsvr32)(\.exe)?$/i;

/** npx o uvx senza versione: ogni avvio può scaricare un pacchetto diverso. */
function unpinned(cmd: string, args: string[]): string | null {
  const base = path.basename(cmd).toLowerCase().replace(/\.(cmd|exe)$/, '');
  if (base !== 'npx' && base !== 'uvx' && base !== 'pnpx' && base !== 'bunx') return null;
  const pkg = args.find((a) => !a.startsWith('-'));
  if (!pkg) return null;
  const version = base === 'uvx' ? /[=@]=?[0-9]/.test(pkg) : /^(@[^/]+\/)?[^@]+@[0-9]/.test(pkg);
  return version ? null : `⚠ ${pkg}: versione non fissata, ogni avvio può scaricarne una diversa (meglio ${pkg}@<versione>).`;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// ── Finestre di conferma ─────────────────────────────────────────────────

/** Una richiesta alla volta sul PC, con tempo massimo; dopo un «No» la stessa proposta si rifiuta da sola per un po'. */
class PcQuestion {
  private pending = false;
  private refused = new Map<string, number>();
  constructor(private confirm: (req: ConfirmRequest, signal: AbortSignal) => Promise<ConfirmAnswer>, readonly timeoutMs: number) {}

  async ask(key: string, title: string, body: string, signal: AbortSignal): Promise<ConfirmAnswer> {
    if ((this.refused.get(key) ?? 0) > Date.now()) throw new FileError('Questa proposta è stata rifiutata sul PC poco fa: non riproporla adesso; continua senza o chiedi in chat.');
    if (this.pending) throw new FileError('Sul PC c\'è già una richiesta in attesa di risposta: aspetta e riprova.');
    this.pending = true;
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    const timer = setTimeout(stop, this.timeoutMs);
    signal.addEventListener('abort', stop);
    try {
      const gone = new Promise<ConfirmAnswer>((resolve) => ctrl.signal.addEventListener('abort', () => resolve('nessuna_risposta')));
      const a = await Promise.race([this.confirm({ title, text: body, timeoutMs: this.timeoutMs }, ctrl.signal), gone]);
      if (a === 'no') this.refused.set(key, Date.now() + REFUSED_MS);
      return a;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      ctrl.abort();
      this.pending = false;
    }
  }

  answerText(a: ConfirmAnswer) {
    return a === 'no'
      ? { esito: 'rifiutata', nota: 'Sul PC hanno risposto no: non riproporla adesso; continua senza o chiedi in chat.' }
      : { esito: 'nessuna risposta', nota: `Nessuna risposta sul PC entro ${duration(this.timeoutMs)} (forse non c'è nessuno): niente è cambiato. Riprova più tardi o chiedi in chat.` };
  }
}

// ── Esecuzione ───────────────────────────────────────────────────────────

const extOk = (p: string, exts?: string[]) => !exts?.length || exts.some((e) => p.toLowerCase().endsWith(e.toLowerCase()));

function paramDescription(n: string, p: CommandParam): string {
  const ext = 'estensioni' in p && p.estensioni?.length ? ` (${p.estensioni.join(', ')})` : '';
  switch (p.tipo) {
    case 'file': return `${p.descrizione ? `${p.descrizione}. ` : ''}Percorso assoluto di un file che esiste, in una cartella consentita del server file${ext}.`;
    case 'uscita': return `${p.descrizione ? `${p.descrizione}. ` : ''}Percorso assoluto del file da creare, in una cartella consentita scrivibile${ext}${p.sovrascrivi ? '; se c\'è già si sostituisce' : '; non deve esistere già'}.`;
    case 'numero': return `${p.descrizione ? `${p.descrizione}. ` : ''}Numero${p.intero ? ' intero' : ''}${p.min != null ? `, minimo ${p.min}` : ''}${p.max != null ? `, massimo ${p.max}` : ''}${p.predefinito != null ? ` (default ${p.predefinito})` : ''}.`;
    case 'testo': return `${p.descrizione ? `${p.descrizione}. ` : ''}Uno tra: ${p.valori.join(', ')}${p.predefinito != null ? ` (default ${p.predefinito})` : ''}.`;
  }
  return n;
}

/** Schema dello strumento: un campo per parametro. */
function inputShape(c: CommandEntry): z.ZodRawShape {
  const shape: Record<string, z.ZodType> = {};
  for (const [n, p] of Object.entries(c.parametri)) {
    let s: z.ZodType;
    if (p.tipo === 'numero') {
      let num = p.intero ? z.number().int() : z.number();
      if (p.min != null) num = num.min(p.min);
      if (p.max != null) num = num.max(p.max);
      s = p.predefinito != null ? num.optional() : num;
    } else if (p.tipo === 'testo') {
      const e = z.enum(p.valori as [string, ...string[]]);
      s = p.predefinito != null ? e.optional() : e;
    } else s = z.string();
    shape[n] = s.describe(paramDescription(n, p));
  }
  return shape;
}

/** Il programma della voce: assoluto, che esiste; su Windows solo .exe o .com (un .bat o .cmd passerebbe da cmd.exe). */
function programOf(c: CommandEntry): string {
  const p = path.resolve(expandPath(c.programma));
  if (!path.isAbsolute(expandPath(c.programma))) throw new FileError(`Il programma deve essere un percorso assoluto: ${c.programma}`);
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { throw new FileError(`Programma non trovato su questo PC: ${p}`); }
  if (!st.isFile()) throw new FileError(`Non è un programma: ${p}`);
  if (WIN && !/\.(exe|com)$/i.test(p)) throw new FileError(`Su Windows si lanciano solo .exe e .com, senza shell: ${p}`);
  return p;
}

/** Chiude il programma e, su Windows, tutti i processi che ha aperto. */
function killTree(pid: number | undefined, child: ReturnType<typeof spawn>) {
  if (WIN && pid) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); return; } catch { /* già chiuso */ }
  }
  child.kill('SIGTERM');
  setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
}

/** Valori dei segnaposto, controllati, e le uscite da guardare dopo. */
function resolveValues(c: CommandEntry, args: Record<string, unknown>, roots: RootSpec[]) {
  const resolved = resolveRoots(roots);
  const values: Record<string, string> = {};
  const outputs: { parametro: string; percorso: string }[] = [];
  const pending: (() => void)[] = [];
  for (const [n, p] of Object.entries(c.parametri)) {
    const v = args[n] ?? ('predefinito' in p ? p.predefinito : undefined);
    if (v === undefined) throw new FileError(`Manca il parametro ${n}.`);
    if (p.tipo === 'file' || p.tipo === 'uscita') {
      if (typeof v !== 'string') throw new FileError(`${n}: serve un percorso.`);
      if (!resolved.length) throw new FileError(`${n}: il server file non ha cartelle consentite su questo PC.`);
      if (!extOk(v, p.estensioni)) throw new FileError(`${n}: estensione non ammessa (${p.estensioni!.join(', ')}).`);
    }
    if (p.tipo === 'file') {
      const r = resolveInside(resolved, v as string);
      let st: fs.Stats;
      try { st = fs.statSync(r.real); } catch { throw new FileError(`${n}: il file non esiste: ${v}`); }
      if (!st.isFile()) throw new FileError(`${n}: non è un file: ${v}`);
      values[n] = r.real;
    } else if (p.tipo === 'uscita') {
      const w = prepareFileWrite(resolved, v as string, p.sovrascrivi === true);
      // Il backup si fa solo quando tutti i parametri vanno bene.
      if (w.exists) pending.push(() => { backupExisting(resolved, w); });
      values[n] = w.real;
      outputs.push({ parametro: n, percorso: w.real });
    } else if (p.tipo === 'numero') {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new FileError(`${n}: serve un numero.`);
      if (p.intero && !Number.isInteger(v)) throw new FileError(`${n}: serve un numero intero.`);
      if ((p.min != null && v < p.min) || (p.max != null && v > p.max)) throw new FileError(`${n}: fuori dall'intervallo consentito.`);
      values[n] = String(v);
    } else {
      if (typeof v !== 'string' || !p.valori.includes(v)) throw new FileError(`${n}: valore non ammesso; uno tra ${p.valori.join(', ')}.`);
      values[n] = v;
    }
  }
  for (const f of pending) f();
  return { values, outputs };
}

/** Argomenti con i valori al posto dei segnaposto ({{ e }} sono graffe vere). */
export function fillArgs(argomenti: string[], values: Record<string, string>): string[] {
  return argomenti.map((a) => a.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (m, n?: string) => (m === '{{' ? '{' : m === '}}' ? '}' : values[n!])));
}

const tail = (s: string) => (s.length > OUTPUT_TAIL ? `…${s.slice(-OUTPUT_TAIL)}` : s);

async function runCommand(name: string, c: CommandEntry, args: Record<string, unknown>, roots: RootSpec[], signal: AbortSignal) {
  const program = programOf(c);
  const cwd = c.cartella ? path.resolve(expandPath(c.cartella)) : os.tmpdir();
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new FileError(`La cartella di lavoro non esiste: ${cwd}`);
  const { values, outputs } = resolveValues(c, args, roots);
  const argv = fillArgs(c.argomenti, values);
  const t0 = Date.now();
  const r = await new Promise<{ code: number | null; signal: string | null; out: string; err: string; timedOut: boolean; aborted: boolean }>((resolve, reject) => {
    // Le variabili del companion (es. CICCIO_COMPANION_TOKEN) non passano al programma.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CICCIO_/i.test(k)));
    const child = spawn(program, argv, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    let aborted = false;
    // Si tiene la fine dell'output, fino a CAPTURE_MAX caratteri.
    child.stdout?.on('data', (d: Buffer) => { out = (out + d.toString('utf8')).slice(-CAPTURE_MAX); });
    child.stderr?.on('data', (d: Buffer) => { err = (err + d.toString('utf8')).slice(-CAPTURE_MAX); });
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid, child); }, c.timeout * 1000);
    const onAbort = () => { aborted = true; killTree(child.pid, child); };
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (e) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(new FileError(`${name}: il programma non parte (${e.message})`)); });
    child.once('close', (code, sig) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve({ code, signal: sig, out, err, timedOut, aborted }); });
  });
  const result = {
    comando: name,
    codice: r.code,
    ...(r.signal ? { segnale: r.signal } : {}),
    ...(r.timedOut ? { scaduto: `chiuso dopo ${c.timeout} s` } : {}),
    ...(r.aborted ? { interrotto: true } : {}),
    durata: `${((Date.now() - t0) / 1000).toFixed(1)} s`,
    uscite: outputs.map((o) => {
      const st = (() => { try { return fs.statSync(o.percorso); } catch { return null; } })();
      return { ...o, esiste: !!st, ...(st ? { dimensione: st.size } : {}) };
    }),
    output: tail(r.out),
    errori: tail(r.err),
  };
  return text(result, r.code !== 0 || r.timedOut || r.aborted);
}

// ── Il server ────────────────────────────────────────────────────────────

export interface CommandsServerOptions {
  /** Cartelle consentite del server «file», com'è adesso (anche quelle «questa volta»). */
  roots?: () => RootSpec[];
  /** Finestra di conferma sul PC. Senza, proponi_comando e proponi_strumento non ci sono. */
  confirm?: (req: ConfirmRequest, signal: AbortSignal) => Promise<ConfirmAnswer>;
  /** «Consenti sempre» di proponi_comando: scrive la voce nella config del PC. */
  saveCommand?: (name: string, c: CommandEntry) => void;
  /** «Consenti sempre» di proponi_strumento: scrive il server nella config, lo avvia e dice com'è andata. */
  addServer?: (name: string, entry: Record<string, unknown>) => Promise<{ stato: string; strumenti: number; errore?: string }>;
  /** Nomi dei server MCP della config (per non proporne uno che c'è già). */
  serverNames?: () => string[];
  /** Comandi cambiati: le istruzioni nuove, per Ciccio. */
  onChange?: (instructions: string) => void;
  /** Attesa della risposta (prove). */
  timeoutMs?: number;
}

/** Il server MCP «comandi». `entry.comandi` è l'elenco vivo: «Consenti sempre» di proponi_comando ci aggiunge la voce. */
export function createCommandsServer(entry: CommandsEntry, opts: CommandsServerOptions = {}): McpServer {
  const commands = entry.comandi;
  const roots = () => opts.roots?.() ?? [];
  const instructions = () => {
    const names = Object.keys(commands);
    return [
      'Programmi a riga di comando consentiti su questo PC: ogni strumento lancia un programma fisso con argomenti fissi, e tu scegli solo i valori dei parametri. I file vanno indicati con percorsi assoluti nelle cartelle consentite del server file (le uscite in quelle scrivibili). Torna il codice d\'uscita, l\'output (troncato) e se i file di uscita ci sono.',
      names.length ? `Comandi: ${names.map((n) => `${n}${commands[n].descrizione ? ` (${commands[n].descrizione!.split('\n')[0].slice(0, 120)})` : ''}`).join('; ')}.` : 'Per ora nessun comando consentito.',
      ...(opts.confirm ? ['Per un programma che non c\'è: proponi_comando; per un server MCP locale nuovo: proponi_strumento. Decide chi è davanti al PC; senza risposta è no. Mai chiavi in chiaro: solo riferimenti a 1Password (op://…).'] : []),
    ].join('\n');
  };
  const server = new McpServer({ name: 'ciccio-companion-comandi', version: '1' }, { capabilities: { tools: { listChanged: true } }, instructions: instructions() });
  const running = new Set<string>();
  const tools = new Map<string, RegisteredTool>();

  const register = (name: string, c: CommandEntry) => {
    const program = expandPath(c.programma);
    tools.set(name, server.registerTool(name, {
      description: `${c.descrizione ? `${c.descrizione}\n` : ''}Lancia sul PC: ${[program, ...c.argomenti].map(shown).join(' ')} (senza shell, al massimo ${c.timeout} s).`,
      inputSchema: inputShape(c),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async (args, extra) => {
      if (running.has(name)) return text(`${name} è già in corso: aspetta che finisca.`, true);
      running.add(name);
      try { return await runCommand(name, c, args as Record<string, unknown>, roots(), extra.signal); } catch (e) { return fail(e); } finally { running.delete(name); }
    }));
  };
  for (const [name, c] of Object.entries(commands)) if (!RESERVED.has(name)) register(name, c);

  if (opts.confirm) {
    const q = new PcQuestion(opts.confirm, opts.timeoutMs ?? ACCESS_TIMEOUT_MS);
    const ending = (what: string) => `«Consenti sempre» ${what}; «No» rifiuta. Senza risposta entro ${duration(q.timeoutMs)}: no.`;

    if (opts.saveCommand) {
      const save = opts.saveCommand;
      server.registerTool('proponi_comando', {
        description: `Propone un programma a riga di comando nuovo da consentire su questo PC (es. lo slicer di Bambu Studio): percorso fisso, argomenti fissi e segnaposto {parametro} tipizzati (file in una cartella consentita, uscita in una scrivibile, numero, testo tra valori ammessi). Sul PC compare una finestra con programma e argomenti esatti: con «Consenti sempre» diventa lo strumento <nome> di questo server. Mai chiavi negli argomenti. Senza risposta entro ${duration(q.timeoutMs)}: no.`,
        inputSchema: {
          nome: z.string().regex(COMMAND_NAME).describe('Nome dello strumento: minuscole, cifre e _ (es. bambu_slice).'),
          descrizione: z.string().max(1000).optional().describe('Cosa fa, per chi lo userà.'),
          programma: z.string().min(1).max(500).describe('Percorso assoluto del programma (es. C:\\Program Files\\Bambu Studio\\bambu-studio.exe).'),
          argomenti: z.array(z.string().max(500)).max(60).describe('Argomenti in ordine; {nome} per un parametro, {{ e }} per le graffe vere.'),
          parametri: z.record(z.string(), z.looseObject({ tipo: z.enum(['file', 'uscita', 'numero', 'testo']) })).optional()
            .describe('Per ogni {nome}: { tipo: "file", estensioni? } | { tipo: "uscita", estensioni?, sovrascrivi? } | { tipo: "numero", min?, max?, intero?, predefinito? } | { tipo: "testo", valori: [...], predefinito? }, con descrizione facoltativa.'),
          timeout: z.number().int().min(1).max(3600).optional().describe('Secondi prima di chiuderlo (default 300).'),
          cartella: z.string().max(500).optional().describe('Cartella di lavoro (default: cartella temporanea).'),
          motivo: z.string().min(1).max(300).describe('Perché serve, in una frase: lo legge chi decide sul PC.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      }, async (a, extra) => {
        try {
          if (RESERVED.has(a.nome) || commands[a.nome]) throw new FileError(`C'è già uno strumento ${a.nome}: scegli un altro nome (per cambiarlo, chiedi all'utente di modificare la config del PC).`);
          const parsed = Command.safeParse({ descrizione: a.descrizione, programma: a.programma, argomenti: a.argomenti, parametri: a.parametri ?? {}, timeout: a.timeout, cartella: a.cartella });
          if (!parsed.success) throw new FileError(`Proposta non valida:\n${prettyError(parsed.error)}`);
          const c = parsed.data;
          visible(c.programma, 'Programma');
          if (c.cartella) visible(c.cartella, 'Cartella');
          if (c.descrizione) visible(c.descrizione.replace(/\n/g, ' '), 'Descrizione');
          checkArgs(c.argomenti);
          for (const [n, p] of Object.entries(c.parametri)) {
            visible(n, 'Parametro');
            if (p.descrizione) visible(p.descrizione, `Descrizione di ${n}`);
            if (p.tipo === 'testo') { p.valori.forEach((v) => visible(v, `Valore di ${n}`)); checkArgs(p.valori); }
          }
          const program = programOf(c);
          if (c.cartella && !(fs.existsSync(path.resolve(expandPath(c.cartella))) && fs.statSync(path.resolve(expandPath(c.cartella))).isDirectory())) throw new FileError(`La cartella di lavoro non esiste: ${c.cartella}`);
          const params = Object.entries(c.parametri).map(([n, p]) => `  {${n}} = ${
            p.tipo === 'file' ? `un file in una cartella consentita${p.estensioni?.length ? ` (${p.estensioni.join(', ')})` : ''}`
            : p.tipo === 'uscita' ? `un percorso in una cartella scrivibile${p.estensioni?.length ? ` (${p.estensioni.join(', ')})` : ''}${p.sovrascrivi ? ', anche sopra un file che c\'è già' : ''}`
            : p.tipo === 'numero' ? `un numero${p.intero ? ' intero' : ''}${p.min != null ? ` da ${p.min}` : ''}${p.max != null ? ` a ${p.max}` : ''}`
            : `uno tra: ${p.valori.join(', ')}`}`);
          const warn = INTERPRETERS.test(path.basename(program)) ? ['⚠ È un interprete di comandi: con questi argomenti potrebbe eseguire altro. Controlla bene.'] : [];
          const body = [
            `Strumento: ${a.nome}${c.descrizione ? ` — ${c.descrizione.split('\n')[0].slice(0, 150)}` : ''}`,
            `Programma:\n${program}`,
            `Argomenti (esattamente questi, in quest'ordine, senza shell):\n${c.argomenti.length ? c.argomenti.map((x) => `  ${shown(x)}`).join('\n') : '  (nessuno)'}`,
            ...(params.length ? [`L'agente sceglie solo:\n${params.join('\n')}`] : []),
            `Cartella di lavoro: ${c.cartella ? path.resolve(expandPath(c.cartella)) : 'temporanea'} · al massimo ${c.timeout} s`,
            ...warn,
            `Motivo scritto dall'agente:\n«${reason(a.motivo)}»`,
            ending('lo aggiunge alla config: da lì gli agenti lo possono lanciare, ogni volta con i permessi della chat'),
          ].join('\n\n');
          const answer = await q.ask(`comando:${a.nome}:${program}`, 'Un agente propone un comando', body, extra.signal);
          if (answer !== 'sì') return text({ ...q.answerText(answer), nome: a.nome });
          save(a.nome, c);
          commands[a.nome] = c;
          // Lo strumento nuovo arriva subito a Ciccio (tools/list_changed), con le istruzioni aggiornate.
          opts.onChange?.(instructions());
          register(a.nome, c);
          return text({ esito: 'consentito', nome: a.nome, nota: `Salvato nella config del PC: lo strumento ${a.nome} c'è già in questo server (in questa sessione potrebbe comparire solo dal prossimo messaggio).` });
        } catch (e) { return fail(e); }
      });
    }

    if (opts.addServer) {
      const add = opts.addServer;
      server.registerTool('proponi_strumento', {
        description: `Propone un server MCP locale nuovo per questo PC: un comando stdio (es. npx -y pacchetto@versione) o un indirizzo locale (http o sse su localhost). Sul PC compare una finestra con il comando esatto: con «Consenti sempre» si aggiunge alla config e parte subito. Le chiavi solo come riferimenti a 1Password (op://vault/elemento/campo) in env o intestazioni: mai in chiaro, né negli argomenti. Senza risposta entro ${duration(q.timeoutMs)}: no.`,
        inputSchema: {
          nome: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).describe('Nome del server: minuscole, cifre e trattini (es. blender).'),
          tipo: z.enum(['comando', 'url']).describe('comando: un programma stdio; url: un server già acceso su questo PC.'),
          comando: z.string().max(500).optional().describe('tipo comando: il programma (npx, uvx, oppure un percorso assoluto).'),
          argomenti: z.array(z.string().max(500)).max(60).optional().describe('tipo comando: gli argomenti; fissa la versione del pacchetto.'),
          env: z.record(z.string(), z.string().max(1000)).optional().describe('tipo comando: variabili d\'ambiente; le chiavi come op://vault/elemento/campo.'),
          url: z.string().max(500).optional().describe('tipo url: http://localhost:<porta>/… (solo questo PC).'),
          trasporto: z.enum(['http', 'sse']).optional().describe('tipo url: http (default) o sse.'),
          intestazioni: z.record(z.string(), z.string().max(1000)).optional().describe('tipo url: intestazioni HTTP; le chiavi come op://….'),
          motivo: z.string().min(1).max(300).describe('Perché serve, in una frase: lo legge chi decide sul PC.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      }, async (a, extra) => {
        try {
          const existing = new Set((opts.serverNames?.() ?? []).map(serverSlug));
          if (existing.has(a.nome)) throw new FileError(`Sul PC c'è già un server «${a.nome}»: scegli un altro nome (per cambiarlo, chiedi all'utente).`);
          let proposal: Record<string, unknown>;
          const lines: string[] = [`Nome: ${a.nome}`];
          const refs: string[] = [];
          if (a.tipo === 'comando') {
            if (!a.comando) throw new FileError('Manca comando.');
            if (a.url || a.intestazioni) throw new FileError('url e intestazioni valgono solo per tipo url.');
            visible(a.comando, 'Comando');
            const args = a.argomenti ?? [];
            checkArgs(args);
            const env = a.env ?? {};
            checkValues(env, 'Variabile');
            const found = findProgram(a.comando);
            if (!found) throw new FileError(`Il programma «${a.comando}» non c'è su questo PC${path.isAbsolute(expandPath(a.comando)) ? '' : ' (né nel PATH)'}.`);
            proposal = { command: a.comando, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
            lines.push(`Comando che verrà eseguito:\n${[a.comando, ...args].map(shown).join(' ')}`);
            if (found !== a.comando) lines.push(`(${a.comando} = ${found})`);
            if (Object.keys(env).length) lines.push(`Variabili d'ambiente:\n${Object.entries(env).map(([k, v]) => { if (OP_REF.test(v)) refs.push(k); return `  ${k} = ${v}${OP_REF.test(v) ? '  ← da 1Password all\'avvio' : ''}`; }).join('\n')}`);
            const w = unpinned(a.comando, args);
            if (w) lines.push(w);
          } else {
            if (!a.url) throw new FileError('Manca url.');
            if (a.comando || a.argomenti || a.env) throw new FileError('comando, argomenti ed env valgono solo per tipo comando.');
            visible(a.url, 'Indirizzo');
            let u: URL;
            try { u = new URL(a.url); } catch { throw new FileError(`Indirizzo non valido: ${a.url}`); }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FileError('Solo indirizzi http o https.');
            if (!LOCAL_HOSTS.has(u.hostname)) throw new FileError('Solo server su questo PC (localhost, 127.0.0.1 o [::1]): i server in rete si aggiungono da Ciccio, non dal PC.');
            if (u.username || u.password) throw new FileError(`Niente utente e password nell'indirizzo. ${NO_PLAIN}`);
            for (const [k, v] of u.searchParams) if (SECRET_NAME.test(k) || looksSecret(v)) throw new FileError(`Il parametro ${k} dell'indirizzo sembra una chiave: va in intestazioni come riferimento op://….`);
            const headers = a.intestazioni ?? {};
            checkValues(headers, 'Intestazione');
            proposal = { type: a.trasporto ?? 'http', url: a.url, ...(Object.keys(headers).length ? { headers } : {}) };
            lines.push(`Indirizzo (${a.trasporto ?? 'http'}):\n${a.url}`);
            if (Object.keys(headers).length) lines.push(`Intestazioni:\n${Object.entries(headers).map(([k, v]) => { if (OP_REF.test(v)) refs.push(k); return `  ${k}: ${v}${OP_REF.test(v) ? '  ← da 1Password all\'avvio' : ''}`; }).join('\n')}`);
          }
          const valid = parseServerEntry(proposal);
          if (!valid.success) throw new FileError(`Proposta non valida:\n${prettyError(valid.error)}`);
          lines.push(refs.length
            ? `Nessuna chiave in chiaro: ${refs.join(', ')} ${refs.length > 1 ? 'sono riferimenti' : 'è un riferimento'} a 1Password, letto a ogni avvio del companion (1Password chiede conferma).`
            : 'Nessuna chiave nella config.');
          if (a.tipo === 'comando') lines.push('⚠ Il server gira con i tuoi permessi su questo PC; i suoi strumenti vanno agli agenti, sempre con i permessi della chat.');
          lines.push(`Motivo scritto dall'agente:\n«${reason(a.motivo)}»`);
          lines.push(ending('lo aggiunge alla config di questo PC e lo avvia'));
          const answer = await q.ask(`server:${a.nome}:${JSON.stringify(proposal)}`, 'Un agente propone uno strumento', lines.join('\n\n'), extra.signal);
          if (answer !== 'sì') return text({ ...q.answerText(answer), nome: a.nome });
          const st = await add(a.nome, proposal);
          return text({
            esito: 'aggiunto', nome: a.nome, stato: st.stato, strumenti: st.strumenti, ...(st.errore ? { errore: st.errore } : {}),
            nota: st.stato === 'online'
              ? 'Salvato nella config del PC e avviato: gli strumenti arrivano a Ciccio subito; in questa sessione potrebbero comparire solo dal prossimo messaggio.'
              : 'Salvato nella config del PC, ma non è partito: il companion riprova da solo; l\'errore dice perché.',
          });
        } catch (e) { return fail(e); }
      });
    }
  }

  return server;
}
