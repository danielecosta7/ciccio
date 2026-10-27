import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { toolStore, type ProjectToolRow } from './db.js';
import { projectEnv, protectedInRepo } from './confine.js';
import { runSandboxed, sandboxAvailable, sandboxed, toolEnv } from './toolSandbox.js';
import { checkRoutine, createRoutine } from './routines.js';
import { describeCron, nextRuns, parseCron } from '../../shared/cron.js';
import type { ProjectToolView } from '../../shared/types.js';
import { OWNER, config } from './config.js';

// Strumenti su misura per progetto, che crescono con l'uso: come «comandi» del companion (companion/src/comandi.ts),
// ma sul server. Un agente propone uno strumento (proponi_comando: un programma del server con argomenti fissi e
// parametri tipizzati; proponi_server_mcp: un server MCP da aggiungere al progetto); all'utente compare la card con il
// comando esatto e solo «Consenti sempre» lo salva. Da lì è dell'agente in tutte le chat del progetto, finché l'utente
// non lo toglie dalle impostazioni del progetto.
// - Niente «esegui un comando qualsiasi»: programma e argomenti sono fissi, l'agente sceglie solo i valori dei
//   segnaposto ({file}, {uscita}, numeri, testi tra valori ammessi), controllati prima di partire. Senza shell.
// - Tutto gira nella sandbox bubblewrap del progetto (toolSandbox.ts): uno strumento approvato non è un'uscita dalla
//   sandbox di Bash. La rete passa comunque solo dal firewall.
// - Usarli segue il livello di autorizzazione della chat (policy.ts): l'utente può approvarli come «sola lettura».
// - Script del repo: programma e argomenti fissi che sono file del repo si ricordano con l'impronta; se l'agente
//   li cambia, lo strumento si ferma finché l'utente non lo riapprova.
// - Cache: il server ha strumenti differiti dietro ToolSearch e nessuna istruzione; uno strumento nuovo arriva come
//   annuncio nei messaggi, senza riscrivere il prefisso della conversazione.
// - crea_routine: l'agente propone una routine per il suo progetto (routines.ts); la conferma l'utente, ogni volta.

export const TOOLS_SERVER = 'ciccio_strumenti';
const full = (n: string) => `mcp__${TOOLS_SERVER}__${n}`;
export const PROPOSE_COMMAND = full('proponi_comando');
export const PROPOSE_MCP = full('proponi_server_mcp');
export const ROUTINE_TOOL = full('crea_routine');
/** Proposte di strumenti: si approvano solo con «Consenti sempre», e solo dall'utente. */
export const PROPOSALS = new Set([PROPOSE_COMMAND, PROPOSE_MCP]);
/** Server MCP approvati: mcp__prj_<nome>__<strumento>. */
const MCP_PREFIX = 'prj_';
const RESERVED = new Set(['proponi_comando', 'proponi_server_mcp', 'crea_routine']);
const COMMAND_NAME = /^[a-z][a-z0-9_]{1,39}$/;
const SERVER_NAME = /^[a-z][a-z0-9-]{1,23}$/;
const OUTPUT_TAIL = 6000;
const MAX_TOOLS = 40;

const text = (o: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) }], ...(isError ? { isError: true } : {}) });
class ToolError extends Error {}
const fail = (e: unknown) => text(e instanceof Error ? e.message : String(e), true);

// ── Forma degli strumenti ────────────────────────────────────────────────

const Param = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('file'), descrizione: z.string().max(300).optional(), estensioni: z.array(z.string().regex(/^\.[a-z0-9]{1,10}$/i)).max(20).optional() }),
  z.object({ tipo: z.literal('uscita'), descrizione: z.string().max(300).optional(), estensioni: z.array(z.string().regex(/^\.[a-z0-9]{1,10}$/i)).max(20).optional(), sovrascrivi: z.boolean().optional() }),
  z.object({ tipo: z.literal('numero'), descrizione: z.string().max(300).optional(), min: z.number().optional(), max: z.number().optional(), intero: z.boolean().optional(), predefinito: z.number().optional() }),
  z.object({ tipo: z.literal('testo'), descrizione: z.string().max(300).optional(), valori: z.array(z.string().min(1).max(200)).min(1).max(50), predefinito: z.string().optional() }),
]);
type Param = z.infer<typeof Param>;

export interface CommandSpec {
  programma: string;
  argomenti: string[];
  parametri: Record<string, Param>;
  timeout: number;
  solaLettura: boolean;
  /** Impronta sha256 dei file del repo fissati nello strumento (programma o argomenti), percorso relativo → hash. */
  impronte: Record<string, string>;
}
export type McpSpec = { tipo: 'comando'; comando: string; argomenti: string[]; env: Record<string, string> } | { tipo: 'url'; url: string };

// ── Controlli sulle proposte (come nel companion) ────────────────────────

/** A capo, caratteri di controllo e inversioni del verso del testo: in una card di conferma potrebbero ingannare. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
function visible(s: string, what: string) {
  if (INVISIBLE.test(s)) throw new ToolError(`${what}: niente a capo né caratteri invisibili.`);
}
const oneLine = (s: string) => s.replace(new RegExp(INVISIBLE.source, 'g'), ' ').replace(/\s+/g, ' ').trim();

const SECRET_NAME = /(key|token|secret|passw|pwd|auth|credential|cookie|session|bearer|private|signature)/i;
const SECRET_VALUE = [/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_/, /\bxox[abprs]-/, /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/, /\bglpat-/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY/];
function looksSecret(v: string): boolean {
  if (SECRET_VALUE.some((r) => r.test(v))) return true;
  return (v.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []).some((w) => /[a-z]/.test(w) && /[A-Z]/.test(w) && /[0-9]/.test(w));
}
const SECRET_FLAG = /^--?[a-z0-9-]*(api[-_]?key|token|secret|passw|pwd|auth)[a-z0-9-]*(=|$)/i;
const NO_SECRETS = `Per ora gli strumenti su misura non portano chiavi: niente segreti negli argomenti o nelle variabili. Se serve una chiave, usa usa_credenziale o chiedi a ${OWNER}.`;

function checkArgs(args: string[]) {
  args.forEach((a, i) => {
    visible(a, `Argomento ${i + 1}`);
    if (/^op:\/\//.test(a) || looksSecret(a) || (SECRET_FLAG.test(a) && (/=./.test(a) || i + 1 < args.length))) throw new ToolError(`Argomento ${i + 1} («${a.slice(0, 40)}»): sembra una chiave. ${NO_SECRETS}`);
  });
}

const INTERPRETERS = /^(bash|sh|dash|zsh|fish|python[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|lua|env|xargs|find|awk|gawk|sed|make|npx|npm|pnpm|yarn|uvx|uv)$/;

/** Un argomento come lo si scriverebbe in un terminale (solo per mostrarlo). */
const shown = (a: string) => (a === '' || /[\s"'`$&|<>()\\;]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function inside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Il programma come lo troverebbe il sistema: un percorso assoluto, o un nome nel PATH del server. */
function findProgram(cmd: string): string | null {
  const isExe = (p: string) => { try { return fs.statSync(p).isFile() && (process.platform === 'win32' || (fs.accessSync(p, fs.constants.X_OK), true)); } catch { return false; } };
  if (path.isAbsolute(cmd)) return isExe(cmd) ? cmd : null;
  if (/[\\/]/.test(cmd)) return null;
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) for (const e of exts) { const p = path.join(dir, cmd + e); if (isExe(p)) return p; }
  return null;
}

function paramLine(n: string, p: Param): string {
  const ext = 'estensioni' in p && p.estensioni?.length ? ` (${p.estensioni.join(', ')})` : '';
  switch (p.tipo) {
    case 'file': return `{${n}} = un file del repo${ext}`;
    case 'uscita': return `{${n}} = un file nuovo nel repo${ext}${p.sovrascrivi ? ', anche sopra uno che c\'è già' : ''}`;
    case 'numero': return `{${n}} = un numero${p.intero ? ' intero' : ''}${p.min != null ? ` da ${p.min}` : ''}${p.max != null ? ` a ${p.max}` : ''}`;
    case 'testo': return `{${n}} = uno tra: ${p.valori.join(', ')}`;
  }
}

function paramDescription(p: Param): string {
  const d = p.descrizione ? `${p.descrizione}. ` : '';
  const ext = 'estensioni' in p && p.estensioni?.length ? ` (${p.estensioni.join(', ')})` : '';
  switch (p.tipo) {
    case 'file': return `${d}Percorso di un file del repo che esiste (relativo alla radice o assoluto)${ext}.`;
    case 'uscita': return `${d}Percorso del file da creare nel repo${ext}${p.sovrascrivi ? '; se c\'è già si sostituisce' : '; non deve esistere già'}.`;
    case 'numero': return `${d}Numero${p.intero ? ' intero' : ''}${p.min != null ? `, minimo ${p.min}` : ''}${p.max != null ? `, massimo ${p.max}` : ''}${p.predefinito != null ? ` (default ${p.predefinito})` : ''}.`;
    case 'testo': return `${d}Uno tra: ${p.valori.join(', ')}${p.predefinito != null ? ` (default ${p.predefinito})` : ''}.`;
  }
}

/** Schema dello strumento approvato: un campo per parametro. */
function inputShape(spec: CommandSpec): z.ZodRawShape {
  const shape: Record<string, z.ZodType> = {};
  for (const [n, p] of Object.entries(spec.parametri)) {
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
    shape[n] = s.describe(paramDescription(p));
  }
  return shape;
}

/** Segnaposto negli argomenti ({{ e }} sono graffe vere). */
function placeholders(args: string[]): Set<string> {
  const out = new Set<string>();
  for (const a of args) for (const m of a.replace(/\{\{|\}\}/g, '').matchAll(/\{([^{}]*)\}/g)) out.add(m[1]);
  return out;
}

export function fillArgs(argomenti: string[], values: Record<string, string>): string[] {
  return argomenti.map((a) => a.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (m, n?: string) => (m === '{{' ? '{' : m === '}}' ? '}' : values[n!])));
}

/** File del repo fissati nello strumento (programma e argomenti senza segnaposto): da ricordare con l'impronta. */
function repoFiles(repo: string, spec: Pick<CommandSpec, 'programma' | 'argomenti'>): string[] {
  const out: string[] = [];
  for (const raw of [spec.programma, ...spec.argomenti.filter((a) => !/\{[^{}]*\}/.test(a.replace(/\{\{|\}\}/g, '')))]) {
    const abs = path.resolve(repo, raw);
    let real: string;
    try { real = fs.realpathSync(abs); } catch { continue; }
    if (inside(real, fs.realpathSync(repo)) && fs.statSync(real).isFile()) out.push(path.relative(fs.realpathSync(repo), real));
  }
  return [...new Set(out)];
}

// ── Esecuzione di uno strumento approvato ────────────────────────────────

function resolveValues(repo: string, spec: CommandSpec, args: Record<string, unknown>) {
  const root = fs.realpathSync(repo);
  const values: Record<string, string> = {};
  const outputs: { parametro: string; percorso: string }[] = [];
  for (const [n, p] of Object.entries(spec.parametri)) {
    const v = args[n] ?? ('predefinito' in p ? p.predefinito : undefined);
    if (v === undefined) throw new ToolError(`Manca il parametro ${n}.`);
    if (p.tipo === 'file' || p.tipo === 'uscita') {
      if (typeof v !== 'string' || !v.trim()) throw new ToolError(`${n}: serve un percorso.`);
      visible(v, n);
      if (p.estensioni?.length && !p.estensioni.some((e) => v.toLowerCase().endsWith(e.toLowerCase()))) throw new ToolError(`${n}: estensione non ammessa (${p.estensioni.join(', ')}).`);
      const abs = path.resolve(root, v);
      if (p.tipo === 'file') {
        let real: string;
        try { real = fs.realpathSync(abs); } catch { throw new ToolError(`${n}: il file non esiste: ${v}`); }
        if (!inside(real, root)) throw new ToolError(`${n}: solo file del repo del progetto.`);
        if (!fs.statSync(real).isFile()) throw new ToolError(`${n}: non è un file: ${v}`);
        values[n] = real;
      } else {
        let dir: string;
        try { dir = fs.realpathSync(path.dirname(abs)); } catch { throw new ToolError(`${n}: la cartella non esiste: ${path.dirname(v)}`); }
        const out = path.join(dir, path.basename(abs));
        if (!inside(out, root)) throw new ToolError(`${n}: si scrive solo nel repo del progetto.`);
        if (protectedInRepo(path.relative(root, out).split(path.sep).join('/'))) throw new ToolError(`${n}: quel percorso decide permessi, hook, server MCP o git del progetto (o è il lavoro di un'altra chat): non si scrive.`);
        if (fs.existsSync(out)) {
          if (!p.sovrascrivi) throw new ToolError(`${n}: il file c'è già (${v}); scegline un altro.`);
          if (fs.lstatSync(out).isSymbolicLink() || !fs.statSync(out).isFile()) throw new ToolError(`${n}: non è un file normale: ${v}`);
        }
        values[n] = out;
        outputs.push({ parametro: n, percorso: path.relative(root, out) });
      }
    } else if (p.tipo === 'numero') {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`${n}: serve un numero.`);
      if (p.intero && !Number.isInteger(v)) throw new ToolError(`${n}: serve un numero intero.`);
      if ((p.min != null && v < p.min) || (p.max != null && v > p.max)) throw new ToolError(`${n}: fuori dall'intervallo consentito.`);
      values[n] = String(v);
    } else {
      if (typeof v !== 'string' || !p.valori.includes(v)) throw new ToolError(`${n}: valore non ammesso; uno tra ${p.valori.join(', ')}.`);
      values[n] = v;
    }
  }
  return { values, outputs };
}

const tail = (s: string) => (s.length > OUTPUT_TAIL ? `…${s.slice(-OUTPUT_TAIL)}` : s);

async function runCommand(repo: string, row: ProjectToolRow, spec: CommandSpec, args: Record<string, unknown>, signal: AbortSignal) {
  const can = sandboxAvailable();
  if (!can.ok) throw new ToolError(can.reason);
  // Script del repo cambiati dopo l'approvazione: lo strumento è fermo finché l'utente non lo riapprova.
  for (const [rel, hash] of Object.entries(spec.impronte)) {
    let now = '';
    try { now = sha256(path.join(repo, rel)); } catch { /* sparito */ }
    if (now !== hash) throw new ToolError(`${rel} è cambiato (o sparito) dopo che ${OWNER} ha approvato ${row.name}: lo strumento è fermo. Chiedi a ${OWNER} di toglierlo dalle impostazioni del progetto e riproponilo.`);
  }
  const program = path.isAbsolute(spec.programma) ? spec.programma : path.resolve(repo, spec.programma);
  const { values, outputs } = resolveValues(repo, spec, args);
  const r = await runSandboxed(row.agent_id, repo, [program, ...fillArgs(spec.argomenti, values)], spec.timeout, signal);
  toolStore.used(row.agent_id, row.name);
  const result = {
    strumento: row.name,
    codice: r.code,
    ...(r.signal ? { segnale: r.signal } : {}),
    ...(r.timedOut ? { scaduto: `chiuso dopo ${spec.timeout} s` } : {}),
    ...(r.aborted ? { interrotto: true } : {}),
    durata: `${(r.ms / 1000).toFixed(1)} s`,
    uscite: outputs.map((o) => {
      const st = (() => { try { return fs.statSync(path.join(repo, o.percorso)); } catch { return null; } })();
      return { ...o, esiste: !!st, ...(st ? { dimensione: st.size } : {}) };
    }),
    output: tail(r.out),
    errori: tail(r.err),
  };
  return text(result, r.code !== 0 || r.timedOut || r.aborted);
}

// ── Viste e gestione ─────────────────────────────────────────────────────

function specOf<T>(row: ProjectToolRow): T { return JSON.parse(row.spec) as T; }

function detailOf(row: ProjectToolRow): string {
  if (row.kind === 'comando') {
    const s = specOf<CommandSpec>(row);
    return [s.programma, ...s.argomenti].map(shown).join(' ');
  }
  const s = specOf<McpSpec>(row);
  return s.tipo === 'url' ? s.url : [s.comando, ...s.argomenti].map(shown).join(' ');
}

export function projectToolViews(agentId: string): ProjectToolView[] {
  return toolStore.list(agentId).map((r) => ({
    name: r.name, kind: r.kind, description: r.description, detail: detailOf(r),
    readOnly: r.kind === 'comando' ? specOf<CommandSpec>(r).solaLettura : false,
    toolName: r.kind === 'comando' ? full(r.name) : `mcp__${MCP_PREFIX}${r.name.replace(/-/g, '_')}__*`,
    createdAt: r.created_at, proposedIn: r.proposed_in, uses: r.uses, lastUsed: r.last_used,
  }));
}

export function removeProjectTool(agentId: string, name: string): boolean {
  return toolStore.remove(agentId, name);
}

/** Cosa si sa di uno strumento su misura per decidere il permesso: se l'utente l'ha approvato come sola lettura. */
export function projectToolHints(agentId: string, toolName: string): { readOnly?: boolean } | undefined {
  if (!toolName.startsWith(`mcp__${TOOLS_SERVER}__`)) return undefined;
  const row = toolStore.get(agentId, toolName.slice(`mcp__${TOOLS_SERVER}__`.length));
  return row?.kind === 'comando' ? { readOnly: specOf<CommandSpec>(row).solaLettura } : undefined;
}

/** Server MCP approvati del progetto, chiusi nella sandbox (stdio) e con gli strumenti differiti. */
export function projectMcpServers(agentId: string, repo: string): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  if (!sandboxAvailable().ok) return out;
  for (const row of toolStore.list(agentId)) {
    if (row.kind !== 'mcp') continue;
    const s = specOf<McpSpec>(row);
    const key = `${MCP_PREFIX}${row.name.replace(/-/g, '_')}`;
    if (s.tipo === 'url') { out[key] = { type: 'http', url: s.url, alwaysLoad: false }; continue; }
    // Cartella temporanea fissa per progetto e server: vive quanto il server, dentro la sandbox è scrivibile.
    const tmp = path.join(os.tmpdir(), `ciccio-mcp-${agentId}-${row.name}`);
    fs.mkdirSync(tmp, { recursive: true });
    const program = findProgram(s.comando) ?? s.comando;
    const { command, args } = sandboxed(agentId, repo, tmp, [program, ...s.argomenti]);
    out[key] = { type: 'stdio', command, args, env: toolEnv(tmp, { ...projectEnv(agentId), ...s.env }), alwaysLoad: false };
  }
  return out;
}

// ── Il server della sessione ─────────────────────────────────────────────

export interface ToolHooks {
  /** Card all'utente; per le proposte `always` = «Consenti sempre». */
  ask: (toolName: string, input: Record<string, unknown>, reason: string) => Promise<{ allowed: boolean; always: boolean }>;
  /** Riga discreta nella chat. */
  note: (t: string) => void;
  agentId: string;
  repo: string;
  /** Titolo della chat, per ricordare da dove è arrivata la proposta. */
  chatTitle: string;
  chatId: string;
}

function commandTool(row: ProjectToolRow, hooks: ToolHooks) {
  const spec = specOf<CommandSpec>(row);
  return tool(row.name,
    `${row.description}\nLancia sul server, nella sandbox del progetto: ${[spec.programma, ...spec.argomenti].map(shown).join(' ')} (senza shell, al massimo ${spec.timeout} s). Strumento su misura approvato da ${OWNER}.`,
    inputShape(spec),
    async (args, extra) => {
      try { return await runCommand(hooks.repo, row, spec, args as Record<string, unknown>, (extra as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal); }
      catch (e) { return fail(e); }
    },
    { annotations: { readOnlyHint: spec.solaLettura, destructiveHint: !spec.solaLettura, openWorldHint: false } });
}

/** Server MCP «ciccio_strumenti» di un giro: le proposte, crea_routine e gli strumenti approvati del progetto. */
export function projectToolsServer(hooks: ToolHooks): McpSdkServerConfigWithInstance {
  const rows = toolStore.list(hooks.agentId);
  const commands = rows.filter((r) => r.kind === 'comando');

  const proponiComando = tool('proponi_comando',
    `Propone uno strumento nuovo per questo progetto: un programma o uno script del server con argomenti fissi e segnaposto {parametro} tipizzati (file del repo, uscita nel repo, numero, testo tra valori ammessi). ${OWNER} vede il comando esatto e con «Consenti sempre» diventa uno strumento tuo in tutte le chat del progetto (dal prossimo messaggio). Gira nella sandbox del progetto, senza shell. Usalo per operazioni che ripeterai, non per un comando una tantum (per quello c'è Bash). Mai chiavi negli argomenti.`,
    {
      nome: z.string().regex(COMMAND_NAME).describe('Nome dello strumento: minuscole, cifre e _ (es. ridimensiona_immagine).'),
      descrizione: z.string().min(3).max(500).describe('Cosa fa, per chi lo userà.'),
      programma: z.string().min(1).max(500).describe('Percorso assoluto del programma (es. /usr/bin/convert) o di uno script del repo (relativo alla radice, es. scripts/report.sh).'),
      argomenti: z.array(z.string().max(500)).max(60).describe('Argomenti in ordine; {nome} per un parametro, {{ e }} per le graffe vere.'),
      parametri: z.record(z.string(), z.looseObject({ tipo: z.enum(['file', 'uscita', 'numero', 'testo']) })).optional()
        .describe('Per ogni {nome}: { tipo: "file", estensioni? } | { tipo: "uscita", estensioni?, sovrascrivi? } | { tipo: "numero", min?, max?, intero?, predefinito? } | { tipo: "testo", valori: [...], predefinito? }, con descrizione facoltativa.'),
      timeout: z.number().int().min(1).max(1800).optional().describe('Secondi prima di chiuderlo (default 120).'),
      sola_lettura: z.boolean().optional().describe('true se non modifica niente (solo legge o calcola): in Auto partirà senza chiedere.'),
      motivo: z.string().min(3).max(300).describe(`Perché serve, in una frase: lo legge ${OWNER}.`),
    },
    async (a) => {
      try {
        if (RESERVED.has(a.nome) || toolStore.get(hooks.agentId, a.nome)) throw new ToolError(`C'è già uno strumento ${a.nome} nel progetto: scegli un altro nome (per cambiarlo, ${OWNER} lo toglie dalle impostazioni del progetto).`);
        if (toolStore.list(hooks.agentId).length >= MAX_TOOLS) throw new ToolError(`Il progetto ha già ${MAX_TOOLS} strumenti su misura: chiedi a ${OWNER} di toglierne qualcuno.`);
        const can = sandboxAvailable();
        if (!can.ok) throw new ToolError(can.reason);
        const params: Record<string, Param> = {};
        for (const [n, raw] of Object.entries(a.parametri ?? {})) {
          if (!/^[a-z][a-z0-9_]{0,30}$/.test(n)) throw new ToolError(`Nome di parametro non valido: «${n}» (minuscole, cifre e _).`);
          const p = Param.safeParse(raw);
          if (!p.success) throw new ToolError(`Parametro ${n} non valido: ${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
          if (p.data.descrizione) visible(p.data.descrizione, `Descrizione di ${n}`);
          if (p.data.tipo === 'testo') { p.data.valori.forEach((v) => visible(v, `Valore di ${n}`)); checkArgs(p.data.valori); }
          params[n] = p.data;
        }
        const used = placeholders(a.argomenti);
        for (const n of used) if (!params[n]) throw new ToolError(`L'argomento usa {${n}}, ma manca nei parametri.`);
        for (const n of Object.keys(params)) if (!used.has(n)) throw new ToolError(`Il parametro ${n} non compare negli argomenti come {${n}}.`);
        visible(a.programma, 'Programma');
        visible(a.descrizione.replace(/\n/g, ' '), 'Descrizione');
        checkArgs(a.argomenti);
        const absProgram = path.isAbsolute(a.programma) ? a.programma : path.resolve(hooks.repo, a.programma);
        if (!path.isAbsolute(a.programma) && !inside(absProgram, hooks.repo)) throw new ToolError('Il programma è un percorso assoluto o uno script dentro il repo.');
        if (!findProgram(absProgram)) throw new ToolError(`Il programma non c'è sul server o non è eseguibile: ${absProgram}${path.isAbsolute(a.programma) ? '' : ' (uno script del repo deve essere eseguibile: chmod +x e la riga #!)'}`);
        const spec: CommandSpec = { programma: a.programma, argomenti: a.argomenti, parametri: params, timeout: a.timeout ?? 120, solaLettura: a.sola_lettura === true, impronte: {} };
        for (const rel of repoFiles(hooks.repo, spec)) spec.impronte[rel] = sha256(path.join(hooks.repo, rel));
        const warn = [
          ...(INTERPRETERS.test(path.basename(absProgram)) ? ['⚠ È un interprete: esegue quello che dicono gli argomenti. Controlla bene.'] : []),
          ...(Object.keys(spec.impronte).length ? [`File del repo fissati: ${Object.keys(spec.impronte).join(', ')}. Se l'agente li cambia, lo strumento si ferma finché non lo riapprovi.`] : []),
        ];
        const riepilogo = [
          `strumento «${a.nome}» — ${oneLine(a.descrizione).slice(0, 200)}`,
          `programma: ${a.programma}`,
          `argomenti (esattamente questi, senza shell): ${a.argomenti.length ? a.argomenti.map(shown).join(' ') : '(nessuno)'}`,
          ...(Object.keys(params).length ? [`l'agente sceglie solo: ${Object.entries(params).map(([n, p]) => paramLine(n, p)).join('; ')}`] : []),
          `${spec.solaLettura ? 'dichiarato di sola lettura (in Auto parte senza chiedere)' : 'modifica file o fa azioni (chiede secondo il livello della chat)'} · al massimo ${spec.timeout} s, nella sandbox del progetto`,
          ...warn,
          `motivo: «${oneLine(a.motivo)}»`,
        ].join('\n');
        const r = await hooks.ask(PROPOSE_COMMAND, { riepilogo, nome: a.nome }, 'strumento nuovo per il progetto: «Consenti sempre» lo salva');
        if (!r.allowed || !r.always) return text({ esito: 'rifiutato', nome: a.nome, nota: `${OWNER} non l\'ha aggiunto: non riproporlo adesso; continua senza o chiedigli in chat.` });
        toolStore.add({ agent_id: hooks.agentId, name: a.nome, kind: 'comando', description: oneLine(a.descrizione), spec: JSON.stringify(spec), created_at: Date.now(), proposed_in: hooks.chatTitle });
        hooks.note(`strumento ${a.nome} aggiunto al progetto`);
        return text({ esito: 'aggiunto', nome: a.nome, nota: `Salvato nel progetto: dal prossimo messaggio c'è lo strumento ${a.nome} (cercalo con ToolSearch se non lo vedi).` });
      } catch (e) { return fail(e); }
    });

  const proponiServer = tool('proponi_server_mcp',
    `Propone un server MCP da aggiungere a questo progetto: un comando stdio (es. npx -y pacchetto@versione, con la versione fissata) che gira nella sandbox del progetto, oppure un indirizzo https di un server remoto (deve essere tra i domini consentiti dal firewall del server). ${OWNER} vede il comando esatto e con «Consenti sempre» i suoi strumenti diventano tuoi in tutte le chat del progetto, dal prossimo messaggio. Mai chiavi in chiaro.`,
    {
      nome: z.string().regex(SERVER_NAME).describe('Nome del server: minuscole, cifre e trattini (es. sqlite).'),
      descrizione: z.string().min(3).max(500).describe('Cosa offre.'),
      tipo: z.enum(['comando', 'url']),
      comando: z.string().max(500).optional().describe('tipo comando: npx, uvx, pnpm o un percorso assoluto.'),
      argomenti: z.array(z.string().max(500)).max(60).optional().describe('tipo comando: gli argomenti; fissa la versione del pacchetto.'),
      env: z.record(z.string(), z.string().max(1000)).optional().describe('tipo comando: variabili d\'ambiente, senza chiavi.'),
      url: z.string().max(500).optional().describe('tipo url: https://…'),
      motivo: z.string().min(3).max(300).describe(`Perché serve, in una frase: lo legge ${OWNER}.`),
    },
    async (a) => {
      try {
        if (toolStore.get(hooks.agentId, a.nome)) throw new ToolError(`C'è già «${a.nome}» nel progetto: scegli un altro nome.`);
        if (toolStore.list(hooks.agentId).length >= MAX_TOOLS) throw new ToolError(`Il progetto ha già ${MAX_TOOLS} strumenti su misura: chiedi a ${OWNER} di toglierne qualcuno.`);
        const can = sandboxAvailable();
        if (!can.ok) throw new ToolError(can.reason);
        visible(a.descrizione.replace(/\n/g, ' '), 'Descrizione');
        let spec: McpSpec;
        const lines: string[] = [`server MCP «${a.nome}» — ${oneLine(a.descrizione).slice(0, 200)}`];
        if (a.tipo === 'comando') {
          if (!a.comando) throw new ToolError('Manca comando.');
          if (a.url) throw new ToolError('url vale solo per tipo url.');
          visible(a.comando, 'Comando');
          const args = a.argomenti ?? [];
          checkArgs(args);
          const env = a.env ?? {};
          for (const [k, v] of Object.entries(env)) {
            visible(k, 'Variabile'); visible(v, `Variabile ${k}`);
            if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new ToolError(`Nome di variabile non valido: «${k}».`);
            if (SECRET_NAME.test(k) || looksSecret(v) || /^op:\/\//.test(v)) throw new ToolError(`Variabile ${k}: sembra una chiave. ${NO_SECRETS}`);
          }
          const found = findProgram(a.comando);
          if (!found) throw new ToolError(`Il programma «${a.comando}» non c'è sul server${path.isAbsolute(a.comando) ? '' : ' (né nel PATH)'}.`);
          spec = { tipo: 'comando', comando: a.comando, argomenti: args, env };
          lines.push(`comando (nella sandbox del progetto, senza shell): ${[a.comando, ...args].map(shown).join(' ')}${found !== a.comando ? ` (${a.comando} = ${found})` : ''}`);
          if (Object.keys(env).length) lines.push(`variabili: ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(', ')}`);
          const base = path.basename(found).replace(/\.(cmd|exe)$/i, '');
          const pkg = args.find((x) => !x.startsWith('-') && x !== 'dlx' && x !== 'exec');
          if (/^(npx|pnpx|bunx|pnpm|uvx)$/.test(base) && pkg && !(base === 'uvx' ? /[=@]=?[0-9]/.test(pkg) : /^(@[^/]+\/)?[^@]+@[0-9]/.test(pkg))) lines.push(`⚠ ${pkg}: versione non fissata, ogni avvio può scaricarne una diversa.`);
          lines.push('⚠ I suoi strumenti vanno all\'agente con i permessi della chat; il processo vede solo il repo del progetto.');
        } else {
          if (!a.url) throw new ToolError('Manca url.');
          if (a.comando || a.argomenti || a.env) throw new ToolError('comando, argomenti ed env valgono solo per tipo comando.');
          visible(a.url, 'Indirizzo');
          let u: URL;
          try { u = new URL(a.url); } catch { throw new ToolError(`Indirizzo non valido: ${a.url}`); }
          if (u.protocol !== 'https:') throw new ToolError('Solo indirizzi https.');
          // Niente indirizzi del server stesso o della rete interna: lì ci sono Ciccio e i suoi servizi.
          if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/i.test(u.hostname) || /\.(local|internal|ts\.net)$/i.test(u.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) throw new ToolError('Solo server pubblici per nome (niente localhost, IP o rete interna).');
          if (u.username || u.password) throw new ToolError(`Niente utente e password nell'indirizzo. ${NO_SECRETS}`);
          for (const [k, v] of u.searchParams) if (SECRET_NAME.test(k) || looksSecret(v)) throw new ToolError(`Il parametro ${k} dell'indirizzo sembra una chiave. ${NO_SECRETS}`);
          spec = { tipo: 'url', url: a.url };
          lines.push(`indirizzo: ${a.url}`);
          if (!firewallAllows(u.hostname)) lines.push(`⚠ ${u.hostname} non è tra i domini consentiti dal firewall del server: senza aggiungerlo in deploy/egress-firewall.sh non risponderà.`);
        }
        lines.push(`motivo: «${oneLine(a.motivo)}»`);
        const r = await hooks.ask(PROPOSE_MCP, { riepilogo: lines.join('\n'), nome: a.nome }, 'server MCP nuovo per il progetto: «Consenti sempre» lo salva');
        if (!r.allowed || !r.always) return text({ esito: 'rifiutato', nome: a.nome, nota: `${OWNER} non l\'ha aggiunto: non riproporlo adesso; continua senza o chiedigli in chat.` });
        toolStore.add({ agent_id: hooks.agentId, name: a.nome, kind: 'mcp', description: oneLine(a.descrizione), spec: JSON.stringify(spec), created_at: Date.now(), proposed_in: hooks.chatTitle });
        hooks.note(`server MCP ${a.nome} aggiunto al progetto`);
        return text({ esito: 'aggiunto', nome: a.nome, nota: `Salvato nel progetto: dal prossimo messaggio ci sono i suoi strumenti (mcp__${MCP_PREFIX}${a.nome.replace(/-/g, '_')}__…, cercali con ToolSearch).` });
      } catch (e) { return fail(e); }
    });

  const creaRoutine = tool('crea_routine',
    `Propone una routine per questo progetto: un messaggio che Ciccio ti manda da solo a orari fissi (cron a 5 campi nel fuso ${config.tz}: minuto ora giorno mese giorno-settimana; es. '0 8 * * 1' = ogni lunedì alle 8, '30 7 * * 1-5' = feriali alle 7:30). Ogni esecuzione parte in una chat nuova senza contesto (o in questa chat, con questa_chat): il testo deve bastare da solo. Ogni esecuzione consuma come un messaggio di ${OWNER}: proponila solo se serve davvero. La conferma ${OWNER}.`,
    {
      nome: z.string().min(1).max(60).describe('Nome breve (es. Punto delle PR).'),
      testo: z.string().min(3).max(8000).describe('Il messaggio che riceverai, chiaro e completo.'),
      quando: z.string().max(100).describe(`Cron a 5 campi, fuso ${config.tz}.`),
      questa_chat: z.boolean().optional().describe('true: scrive sempre in questa chat, con la sua sessione; default: chat nuova ogni volta.'),
      motivo: z.string().min(3).max(300).describe(`Perché serve, in una frase: lo legge ${OWNER}.`),
    },
    async (a) => {
      try {
        const input = { agentId: hooks.agentId, name: oneLine(a.nome), text: a.testo, cron: a.quando, chatId: a.questa_chat ? hooks.chatId : null };
        checkRoutine(input);
        const next = nextRuns(parseCron(a.quando), Date.now(), 3).map((t) => new Intl.DateTimeFormat('it-IT', { timeZone: config.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(t)));
        const riepilogo = [
          `routine «${input.name}» — ${describeCron(a.quando)}${next.length ? ` (prossime: ${next.join(', ')})` : ''}`,
          a.questa_chat ? `scrive sempre in questa chat («${hooks.chatTitle}»)` : 'ogni volta in una chat nuova, senza contesto',
          `messaggio: «${oneLine(a.testo).slice(0, 500)}»`,
          `motivo: «${oneLine(a.motivo)}»`,
        ].join('\n');
        const r = await hooks.ask(ROUTINE_TOOL, { riepilogo, nome: input.name }, 'routine nuova: consuma da sola a ogni esecuzione');
        if (!r.allowed) return text({ esito: 'rifiutata', nota: `${OWNER} non ha creato la routine: non riproporla adesso.` });
        const v = createRoutine(input, 'agente');
        hooks.note(`routine «${v.name}» creata: ${v.when}`);
        return text({ esito: 'creata', nome: v.name, quando: v.when, prossima: v.nextRun ? new Date(v.nextRun).toISOString() : null });
      } catch (e) { return fail(e); }
    });

  return createSdkMcpServer({
    name: TOOLS_SERVER,
    version: '1.0.0',
    // Strumenti differiti dietro ToolSearch: uno nuovo arriva come annuncio, senza riscrivere il prefisso.
    alwaysLoad: false,
    tools: [proponiComando, proponiServer, creaRoutine, ...commands.map((r) => commandTool(r, hooks))],
  });
}

/** Il dominio è tra quelli che tinyproxy lascia uscire (se l'elenco si legge; altrimenti non si sa e non si avvisa). */
function firewallAllows(host: string): boolean {
  let rules: string[];
  try { rules = fs.readFileSync('/etc/tinyproxy/ciccio-allow', 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch { return true; }
  return rules.some((r) => { try { return new RegExp(r, 'i').test(host); } catch { return false; } });
}
