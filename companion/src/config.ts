import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { OP_REF, parseBridgeTarget } from '../../shared/companion.js';

// Config locale del companion: dove sta Ciccio, il token del dispositivo e i server MCP da esporre.
// I server MCP si scrivono come in .mcp.json: un comando stdio, oppure un indirizzo locale (sse/http).
// Nei valori di `env` e `headers` una chiave si scrive come riferimento a 1Password (op://vault/elemento/campo):
// il companion la legge all'avvio del server (1Password chiede Windows Hello o Touch ID) e non la salva da nessuna parte.

export const VERSION = '0.9.0';

/** Cartella del companion: config, registro, PID e copia in background. CICCIO_COMPANION_HOME la sposta (prove). */
export const configDir = () => process.env.CICCIO_COMPANION_HOME || path.join(os.homedir(), '.ciccio-companion');
export const defaultConfigPath = () => path.join(configDir(), 'config.json');

/**
 * Come si lancia questo programma da un terminale, per i suggerimenti: il programma installato
 * non è nel PATH, quindi il percorso vero (su Windows con la sintassi di PowerShell). Da sorgente, il nome.
 */
export function cli(): string {
  const exe = process.execPath;
  const base = path.basename(exe).toLowerCase();
  if (!base.startsWith('ciccio-companion')) return 'ciccio-companion';
  if (process.platform !== 'win32') return `"${exe}"`;
  // La copia "background" non ha console: da terminale si usa quella accanto.
  return `& "${base.includes('-background') ? path.join(path.dirname(exe), 'ciccio-companion.exe') : exe}"`;
}

const Common = {
  /** true = non esporre questo server. */
  disabled: z.boolean().optional(),
  /** Solo questi strumenti (nomi o schemi con *): se manca, tutti. */
  allow: z.array(z.string()).optional(),
  /** Mai questi strumenti (nomi o schemi con *). */
  deny: z.array(z.string()).optional(),
};

const Stdio = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  ...Common,
});

const Remote = z.object({
  type: z.enum(['sse', 'http']),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
  ...Common,
});

/**
 * Server integrato nel companion, senza processi esterni. Per ora solo `file`: copia file e cartelle tra le
 * cartelle consentite (`roots`). Spento finché la voce non c'è. `roots` può essere vuoto: le cartelle le chiede
 * l'agente con chiedi_accesso e le consente chi è davanti al PC.
 * `backup` (relativo alla root): prima di sovrascrivere ci va la versione esistente, con lo stesso percorso relativo.
 * `solaLettura`: da lì si elenca e si copia verso le altre cartelle, ma dentro non si scrive niente.
 */
const Root = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    backup: z.string().min(1).refine((b) => !/^([A-Za-z]:|[\\/~%])/.test(b) && !b.split(/[\\/]/).includes('..'), 'deve essere relativo alla root, senza ..').optional(),
    solaLettura: z.boolean().optional(),
  }).refine((r) => !(r.solaLettura && r.backup), 'una cartella in sola lettura non ha backup (non vi si scrive)'),
]);
const FileBuiltin = z.object({
  type: z.literal('builtin'),
  builtin: z.literal('file'),
  roots: z.array(Root).default([]),
  ...Common,
});

/** Nome di un comando consentito, che diventa il nome dello strumento. */
export const COMMAND_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** Nome di un parametro: si scrive {nome} negli argomenti. */
const PARAM_NAME = /^[a-z][a-z0-9_]{0,29}$/;
const Desc = z.string().max(500).optional();
const Ext = z.array(z.string().regex(/^\.[A-Za-z0-9]{1,10}$/, 'estensione come .stl')).max(20).optional();
/**
 * Parametro di un comando, cioè cosa può scegliere l'agente:
 * - file: un file che esiste, dentro una cartella consentita del server «file» (anche in sola lettura);
 * - uscita: un percorso in una cartella scrivibile del server «file» (se c'è già, solo con `sovrascrivi`);
 * - numero: con `min`, `max` e `intero`;
 * - testo: solo uno dei `valori` ammessi.
 */
const Param = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('file'), descrizione: Desc, estensioni: Ext }),
  z.object({ tipo: z.literal('uscita'), descrizione: Desc, estensioni: Ext, sovrascrivi: z.boolean().optional() }),
  z.object({ tipo: z.literal('numero'), descrizione: Desc, min: z.number().optional(), max: z.number().optional(), intero: z.boolean().optional(), predefinito: z.number().optional() }),
  z.object({ tipo: z.literal('testo'), descrizione: Desc, valori: z.array(z.string().min(1).max(200)).min(1).max(100), predefinito: z.string().optional() }),
]);
export type CommandParam = z.infer<typeof Param>;

/** {nome} negli argomenti; {{ e }} sono graffe vere. */
export function placeholders(arg: string): string[] | null {
  const out: string[] = [];
  const rest = arg.replace(/\{\{|\}\}/g, '').replace(/\{([^{}]*)\}/g, (_m, n: string) => { out.push(n); return ''; });
  return /[{}]/.test(rest) ? null : out;
}

/**
 * Un programma a riga di comando consentito: percorso fisso, argomenti fissi con segnaposto tipizzati.
 * Si lancia senza shell (execFile con l'elenco degli argomenti): nessun valore diventa un comando.
 */
export const Command = z.object({
  descrizione: z.string().max(1000).optional(),
  /** Percorso assoluto del programma (anche con ~ o %VARIABILE%). */
  programma: z.string().min(1).max(500),
  argomenti: z.array(z.string().max(500)).max(60).default([]),
  parametri: z.record(z.string().regex(PARAM_NAME, 'nome di parametro: minuscole, cifre e _'), Param).default({}),
  /** Secondi, poi il programma si chiude. */
  timeout: z.number().int().min(1).max(3600).default(300),
  /** Cartella di lavoro del programma (default: cartella temporanea). */
  cartella: z.string().min(1).max(500).optional(),
}).superRefine((c, ctx) => {
  const used = new Set<string>();
  c.argomenti.forEach((a, i) => {
    const names = placeholders(a);
    if (!names) { ctx.addIssue({ code: 'custom', path: ['argomenti', i], message: 'graffe non chiuse: {parametro}, oppure {{ e }} per le graffe vere' }); return; }
    for (const n of names) {
      if (!c.parametri[n]) ctx.addIssue({ code: 'custom', path: ['argomenti', i], message: `{${n}} non è tra i parametri` });
      used.add(n);
    }
  });
  for (const n of Object.keys(c.parametri)) if (!used.has(n)) ctx.addIssue({ code: 'custom', path: ['parametri', n], message: 'parametro non usato negli argomenti' });
});
export type CommandEntry = z.infer<typeof Command>;

/**
 * Server integrato `comandi`: ogni voce di `comandi` è uno strumento. Ha anche proponi_comando e
 * proponi_strumento, con cui un agente propone una voce nuova o un server MCP nuovo: decide la finestra sul PC.
 */
const CommandsBuiltin = z.object({
  type: z.literal('builtin'),
  builtin: z.literal('comandi'),
  comandi: z.record(z.string().regex(COMMAND_NAME, 'nome del comando: minuscole, cifre e _ (inizia con una lettera)'), Command).default({}),
  ...Common,
});

// Discriminate su type e builtin: un errore dice cosa non va nella voce, non solo «Invalid input».
const ServerEntry = z.discriminatedUnion('type', [z.discriminatedUnion('builtin', [FileBuiltin, CommandsBuiltin]), Remote, Stdio]);
export type ServerEntry = z.infer<typeof ServerEntry>;
export type FileEntry = z.infer<typeof FileBuiltin>;
export type CommandsEntry = z.infer<typeof CommandsBuiltin>;
/** Controlla una voce nuova di mcpServers (proposta da un agente) come se fosse nella config. */
export const parseServerEntry = (raw: unknown) => ServerEntry.safeParse(raw);
export const prettyError = (e: z.ZodError) => z.prettifyError(e);

const Config = z.object({
  /** Indirizzo di Ciccio (da init --server o dal primo link di abbinamento): vuoto finché non è collegato. */
  server: z.union([z.literal(''), z.url()]).default(''),
  token: z.string().default(''),
  mcpServers: z.record(z.string(), ServerEntry).default({}),
  /** Avvisi di Ciccio come notifiche del sistema, mostrate dall'app dell'icona (Mac e Windows). */
  notifications: z.boolean().default(true),
  /** Migrazioni già fatte su questa config (vedi migrateConfig): non si ripetono. */
  migrazioni: z.array(z.string()).default([]),
  /**
   * 1Password, consentiti per sempre su questo PC (consensi.ts): `segreti` sono riferimenti op:// che Ciccio
   * legge senza finestra, `ssh` accessi utente@server (nome di known_hosts) firmati senza finestra.
   * Si aggiungono con «Consenti sempre» nella finestra, o a mano; tutto il resto chiede ogni volta.
   */
  onePassword: z.object({
    segreti: z.array(z.string().regex(OP_REF, 'riferimento op://vault/elemento/campo')).default([]),
    ssh: z.array(z.string().regex(/^[\w.@+-]{1,64}@[\w.:[\]-]{1,255}$/, 'utente@server, come in known_hosts')).default([]),
  }).default({ segreti: [], ssh: [] }),
  /**
   * Ponti SSH (ponte.ts): server SSH che Ciccio raggiunge passando da questo PC, come "host:porta" (22 se manca),
   * con nome host o IPv4. Solo queste destinazioni esatte; si aggiungono con «Consenti» nella finestra del PC
   * (proposta da Ciccio › Configurazione › Server SSH) o a mano, e si tolgono da Ciccio o a mano.
   */
  ssh: z.object({
    ponti: z.array(z.string().refine((v) => !!parseBridgeTarget(v), 'host o host:porta (nome o IPv4, es. 192.168.1.50:22)')).max(100).default([]),
  }).default({ ponti: [] }),
});
export type CompanionConfig = z.infer<typeof Config>;

/**
 * Percorsi della config: `~/...` è la cartella utente e `%NOME%` una variabile d'ambiente
 * (es. %USERPROFILE%, %LOCALAPPDATA%), su Mac e su Windows. Le variabili sconosciute restano come sono.
 */
export function expandPath(s: string): string {
  const vars = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? process.env[key]! : m;
  });
  if (vars === '~') return os.homedir();
  return vars.startsWith('~/') || vars.startsWith('~\\') ? path.join(os.homedir(), vars.slice(2)) : vars;
}

export function loadConfig(file: string): CompanionConfig {
  if (!fs.existsSync(file)) throw new Error(`Config non trovata: ${file}\nCreala con: ${cli()} init <token>`);
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Config non valida (${file}): ${(e as Error).message}`); }
  const parsed = Config.safeParse(raw);
  if (!parsed.success) throw new Error(`Config non valida (${file}):\n${z.prettifyError(parsed.error)}`);
  const cfg = parsed.data;
  if (process.env.CICCIO_COMPANION_TOKEN) cfg.token = process.env.CICCIO_COMPANION_TOKEN;
  if (process.env.CICCIO_COMPANION_SERVER) cfg.server = process.env.CICCIO_COMPANION_SERVER;
  return cfg;
}

/** Config di partenza: Affinity (server SSE dell'app) e Chrome su un profilo dedicato, senza statistiche verso Google né Canva. */
export function templateConfig(token: string, server: string): CompanionConfig {
  return {
    server,
    token,
    notifications: true,
    onePassword: { segreti: [], ssh: [] },
    ssh: { ponti: [] },
    // Le config nuove hanno già tutto quello che aggiungerebbero le migrazioni.
    migrazioni: MIGRAZIONI.map((m) => m.nome),
    mcpServers: {
      // Stesso indirizzo su Mac e Windows (in Affinity: Impostazioni › Model Context Protocol).
      // Gli "SDK hints" e le segnalazioni finiscono in un archivio condiviso di Canva: esclusi.
      affinity: { type: 'sse', url: 'http://localhost:6767/sse', deny: ['search_sdk_hints', 'add_sdk_hint', 'report_sdk_issue'] },
      // Cartelle (nessuna all'inizio): le chiedono gli agenti con chiedi_accesso, si consentono nella finestra del PC.
      file: { type: 'builtin', builtin: 'file', roots: [] },
      // Comandi consentiti (nessuno all'inizio) e proposte degli agenti, che si accettano nella finestra del PC.
      comandi: { type: 'builtin', builtin: 'comandi', comandi: {} },
      chrome: {
        command: 'npx',
        args: [
          '-y', 'chrome-devtools-mcp@1.11.0',
          '--userDataDir', '~/.ciccio-companion/chrome-profile',
          '--usageStatistics=false', '--performanceCrux=false', '--redactNetworkHeaders',
        ],
        env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
      },
    },
  };
}

/**
 * Cambia la config sul disco lasciando tutto il resto com'è (anche quello che lo schema non conosce):
 * il file nuovo si controlla prima di sostituire quello vecchio, una config rotta non si scrive mai.
 */
export function updateConfig(file: string, change: (raw: { mcpServers?: Record<string, Record<string, unknown>> } & Record<string, unknown>) => void) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(raw);
  const tmp = `${file}.tmp`;
  // Il token è una chiave: il file lo legge solo l'utente.
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  try {
    loadConfig(tmp);
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/**
 * Server integrati arrivati con una versione nuova, da aggiungere anche alle config create prima.
 * Ognuna si fa una volta sola e si segna in `migrazioni`: se poi l'utente toglie la voce, non ricompare.
 */
/** Aggiunge la voce `builtin` se nella config non c'è né un server integrato di quel tipo né una voce con quel nome. */
const addBuiltin = (builtin: string, entry: Record<string, unknown>) => (servers: Record<string, Record<string, unknown>>) => {
  if (builtin in servers || Object.values(servers).some((e) => e?.type === 'builtin' && e.builtin === builtin)) return false;
  servers[builtin] = { type: 'builtin', builtin, ...entry };
  return true;
};
const MIGRAZIONI: { nome: string; applica: (servers: Record<string, Record<string, unknown>>) => boolean }[] = [
  // 0.7.0: comandi consentiti e proposte degli agenti (proponi_comando, proponi_strumento).
  { nome: 'comandi', applica: addBuiltin('comandi', { comandi: {} }) },
  // 0.7.1: «file» senza cartelle; le chiedono gli agenti con chiedi_accesso e le consente chi è al PC.
  { nome: 'file', applica: addBuiltin('file', { roots: [] }) },
];

/**
 * All'avvio: le migrazioni che mancano a questa config, scritte con updateConfig. Restituisce i server aggiunti.
 * Senza config, o con una config che non si legge, non fa niente (l'errore lo dà loadConfig).
 */
export function migrateConfig(file: string): string[] {
  let raw: { migrazioni?: unknown; mcpServers?: unknown };
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  if (!raw || typeof raw !== 'object') return [];
  const done = Array.isArray(raw.migrazioni) ? raw.migrazioni : [];
  if (MIGRAZIONI.every((m) => done.includes(m.nome))) return [];
  const added: string[] = [];
  try {
    updateConfig(file, (cfg) => {
      const servers = (cfg.mcpServers ??= {});
      const list = (cfg.migrazioni = Array.isArray(cfg.migrazioni) ? cfg.migrazioni : []) as string[];
      for (const m of MIGRAZIONI) {
        if (list.includes(m.nome)) continue;
        if (m.applica(servers)) added.push(m.nome);
        list.push(m.nome);
      }
    });
  } catch { return []; }
  return added;
}

/** JSON con le chiavi in ordine: per capire se una voce della config è cambiata davvero. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function writeConfig(file: string, cfg: CompanionConfig) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Il token è una chiave: il file lo legge solo l'utente.
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* su Windows contano i permessi della cartella utente */ }
}

/** Filtro allow/deny sui nomi degli strumenti; * vale qualsiasi sequenza di caratteri. */
export function toolAllowed(entry: ServerEntry, name: string): boolean {
  const match = (p: string) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);
  if (entry.deny?.some(match)) return false;
  return !entry.allow || entry.allow.some(match);
}

/** Notifiche in attesa per l'app dell'icona: un file JSON per notifica (NotifyParams). */
export const notifyDir = () => path.join(configDir(), 'notify');

/** L'app dell'icona (Mac o Windows) avvia il companion con CICCIO_COMPANION_TRAY=1: solo lei mostra le notifiche. */
export const underTray = () => process.env.CICCIO_COMPANION_TRAY === '1';
