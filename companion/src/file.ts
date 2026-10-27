import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { configDir, expandPath } from './config.js';
import { MAX_TRANSFER_BYTES, TRANSFER_META, TRANSFER_TOOLS, type TransferKind, type TransferParams } from '../../shared/companion.js';

// Server MCP «file», integrato nel companion (nessun processo né pacchetto esterno): copia file e cartelle
// tra le cartelle consentite della config, e porta file da e verso il repo dell'agente su Ciccio (scarica_da_ciccio,
// carica_su_ciccio). Niente cancellazioni, niente comandi, niente lettura del contenuto.
// Ogni percorso, di partenza e di arrivo, deve stare dentro una delle cartelle consentite DOPO realpath:
// `..`, collegamenti simbolici e junction di Windows che portano fuori vengono rifiutati.
// Le cartelle in sola lettura fanno solo da origine. Una cartella nuova si chiede con chiedi_accesso:
// decide chi è davanti al PC (finestra del companion), mai Ciccio.

export type RootSpec = string | {
  /** Cartella consentita (con ~ e %VAR% espansi). */
  path: string;
  /** Cartella di backup, relativa alla root: prima di sovrascrivere ci va la versione esistente (stesso percorso relativo). */
  backup?: string;
  /** Si elenca e si copia da qui verso le altre cartelle, ma dentro non si scrive niente. */
  solaLettura?: boolean;
  /** Consentita «questa volta» (non nella config): vale fino a questo istante (ms). */
  finoA?: number;
};

const WIN = process.platform === 'win32';
/** Server «file» senza cartelle (config nuova): si chiedono con chiedi_accesso. */
const NO_ROOTS = 'Nessuna cartella consentita ancora: chiedi quella che serve con chiedi_accesso.';
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 5000;
/** Quanto si aspetta la risposta a chiedi_accesso prima di rispondere «nessuna risposta». */
export const ACCESS_TIMEOUT_MS = 3 * 60_000;
/** «Consenti questa volta»: vale finché il companion resta acceso, al massimo così. */
export const ONCE_MS = 8 * 60 * 60_000;
/** Dopo un «No», la stessa cartella si rifiuta da sola per questo tempo (niente finestre a raffica). */
const REFUSED_MS = 10 * 60_000;

/** Errore da mostrare così com'è all'agente. */
export class FileError extends Error {}

export interface ResolvedRoot { real: string; backup?: string; label: string; readOnly: boolean; until?: number }

function real(p: string): string { return fs.realpathSync.native(p); }
const norm = (p: string) => (WIN ? p.toLowerCase() : p);

/** `child` è `parent` o sta sotto (confronto senza maiuscole su Windows, anche tra lettere di unità diverse). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** realpath del tratto già esistente + il resto (che non esiste ancora, senza `..`). */
function realpathLoose(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try { return path.join(real(head), ...tail.reverse()); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new FileError(`Percorso non leggibile: ${abs} (${(e as Error).message})`);
      const parent = path.dirname(head);
      if (parent === head) throw new FileError(`Percorso non valido: ${abs}`);
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/**
 * La cartella del companion (config con il token, registro) non si può consentire, né direttamente né dentro
 * una cartella più grande: con la scrittura un agente potrebbe allargarsi le cartelle da solo.
 */
function assertNotCompanionDir(r: string, what: string) {
  const own = realpathLoose(path.resolve(configDir()));
  if (isInside(r, own) || isInside(own, r)) throw new FileError(`${what} contiene la cartella del companion (config con il token): non si può consentire.`);
}

export function resolveRoots(specs: RootSpec[]): ResolvedRoot[] {
  return specs.map((s) => {
    const spec = typeof s === 'string' ? { path: s } : s;
    const abs = path.resolve(expandPath(spec.path));
    const r = realpathLoose(abs); // la root può non esistere ancora (es. Desktop\schede_lavoro): si crea con crea_cartella
    assertNotCompanionDir(r, `La cartella consentita ${abs}`);
    let backup: string | undefined;
    if (spec.backup && !spec.solaLettura) {
      if (path.isAbsolute(spec.backup) || spec.backup.split(/[\\/]/).includes('..')) throw new FileError(`Backup non valido (deve essere relativo alla root, senza ..): ${spec.backup}`);
      backup = realpathLoose(path.join(r, spec.backup));
      if (!isInside(r, backup)) throw new FileError(`Il backup di ${spec.path} esce dalla root: ${spec.backup}`);
    }
    return { real: r, backup, label: abs, readOnly: spec.solaLettura === true, ...(spec.finoA ? { until: spec.finoA } : {}) };
  });
}

/** Percorso della richiesta → percorso reale (del tratto che esiste). Rifiuta relativi, vuoti e flussi alternativi. */
function toReal(input: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new FileError('Percorso mancante.');
  if (input.includes('\0')) throw new FileError('Percorso non valido.');
  const expanded = expandPath(input.trim());
  if (!path.isAbsolute(expanded)) throw new FileError(`Il percorso deve essere assoluto (o iniziare con ~ o %VARIABILE%): ${input}`);
  // Su Windows i due punti fuori dalla lettera dell'unità indicano flussi alternativi (file.txt:flusso).
  if (WIN && /:/.test(expanded.replace(/^(\\\\\?\\)?[A-Za-z]:/, ''))) throw new FileError(`Percorso non valido: ${input}`);
  return realpathLoose(path.resolve(expanded));
}

/** La root più specifica che contiene `r` (una sottocartella consentita a parte vince sulla cartella che la contiene). */
const rootOf = (roots: ResolvedRoot[], r: string) => roots.filter((x) => isInside(x.real, r)).sort((a, b) => b.real.length - a.real.length)[0];

const rootLine = (x: ResolvedRoot) => `- ${x.label}${x.readOnly ? ' (sola lettura)' : ''}`;

/**
 * Porta un percorso della richiesta a percorso reale dentro una root. Rifiuta ciò che sta fuori.
 * Ritorna anche la root più specifica che lo contiene.
 */
export function resolveInside(roots: ResolvedRoot[], input: string): { real: string; root: ResolvedRoot } {
  const r = toReal(input);
  const root = rootOf(roots, r);
  if (!root) {
    throw new FileError(`Percorso fuori dalle cartelle consentite: ${input}\n${roots.length ? `Cartelle consentite:\n${roots.map(rootLine).join('\n')}` : NO_ROOTS}`);
  }
  return { real: r, root };
}

/**
 * Dove si scrive (`real` e tutto quello che c'è sotto) non tocca cartelle in sola lettura: né quella che lo
 * contiene, né una consentita a parte più in basso (copiare una cartella sopra la sua madre ci scriverebbe dentro).
 */
function assertWritable(roots: ResolvedRoot[], real: string) {
  const root = rootOf(roots, real);
  if (root?.readOnly) {
    const writable = roots.filter((x) => !x.readOnly);
    throw new FileError(`${root.label} è in sola lettura: si può copiare da lì, non scriverci.\n${writable.length ? `Cartelle scrivibili:\n${writable.map(rootLine).join('\n')}` : 'Nessuna cartella scrivibile.'}`);
  }
  const below = roots.find((x) => x.readOnly && isInside(real, x.real));
  if (below) throw new FileError(`Dentro ${real} c'è una cartella in sola lettura (${below.label}): non ci scrivo sopra.`);
}

/** Come resolveInside, ma ci si deve poter scrivere (vedi assertWritable). */
export function resolveWritable(roots: ResolvedRoot[], input: string): { real: string; root: ResolvedRoot } {
  const res = resolveInside(roots, input);
  assertWritable(roots, res.real);
  return res;
}

const iso = (d: Date) => d.toISOString();
type Kind = 'file' | 'cartella' | 'collegamento' | 'altro';
const kindOf = (s: fs.Stats): Kind => (s.isSymbolicLink() ? 'collegamento' : s.isDirectory() ? 'cartella' : s.isFile() ? 'file' : 'altro');

function describe(abs: string, s: fs.Stats) {
  return { nome: path.basename(abs), tipo: kindOf(s), ...(s.isFile() ? { dimensione: s.size } : {}), modificato: iso(s.mtime) };
}

export function listDir(roots: ResolvedRoot[], dir: string, recursive: boolean, limit: number) {
  const { real: base } = resolveInside(roots, dir);
  let st: fs.Stats;
  try { st = fs.statSync(base); } catch { throw new FileError(`La cartella non esiste: ${dir}`); }
  if (!st.isDirectory()) throw new FileError(`Non è una cartella: ${dir}`);
  const out: ReturnType<typeof describe>[] = [];
  let truncated = false;
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (out.length >= limit) { truncated = true; return; }
      const p = path.join(d, name);
      let s: fs.Stats;
      try { s = fs.lstatSync(p); } catch { continue; }
      out.push({ ...describe(p, s), nome: path.relative(base, p).split(path.sep).join('/') });
      // I collegamenti non si seguono: potrebbero portare fuori dalle cartelle consentite.
      if (recursive && s.isDirectory()) walk(p);
      if (truncated) return;
    }
  };
  walk(base);
  return { cartella: base, voci: out, troncato: truncated };
}

export function pathInfo(roots: ResolvedRoot[], p: string) {
  const { real: abs } = resolveInside(roots, p);
  let s: fs.Stats;
  try { s = fs.lstatSync(abs); } catch { return { percorso: abs, esiste: false }; }
  return { percorso: abs, esiste: true, ...describe(abs, s) };
}

function lstatOrNull(p: string): fs.Stats | null {
  try { return fs.lstatSync(p); } catch { return null; }
}

/**
 * Dove la copia di `src` scriverebbe dentro `dst` non ci devono essere collegamenti: una junction già presente
 * in una sottocartella della destinazione porterebbe la scrittura fuori dalla root. Si controlla tutto prima
 * di scrivere qualcosa, così un rifiuto non lascia copie a metà.
 */
function assertNoLinksAt(src: string, dst: string) {
  const s = fs.lstatSync(src);
  if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) return; // non si copia
  const d = lstatOrNull(dst);
  if (!d) return; // da qui in giù è tutto nuovo
  if (d.isSymbolicLink()) throw new FileError(`Nella destinazione c'è un collegamento, non ci scrivo: ${dst}`);
  if (s.isDirectory() !== d.isDirectory()) throw new FileError(`Nella destinazione c'è ${d.isDirectory() ? 'una cartella al posto di un file' : 'un file al posto di una cartella'}: ${dst}`);
  if (s.isDirectory()) for (const name of fs.readdirSync(src)) assertNoLinksAt(path.join(src, name), path.join(dst, name));
}

/** Copia ricorsiva senza seguire i collegamenti (saltati e contati). `overwrite:false` lascia ciò che c'è già. */
function copyTree(src: string, dst: string, overwrite: boolean, stats: { files: number; skippedLinks: number; kept: number }) {
  const s = fs.lstatSync(src);
  if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) { stats.skippedLinks++; return; }
  // Di nuovo a ogni passo (assertNoLinksAt l'ha già visto): mai scrivere attraverso un collegamento.
  const d = lstatOrNull(dst);
  if (d?.isSymbolicLink()) throw new FileError(`Nella destinazione c'è un collegamento, non ci scrivo: ${dst}`);
  if (s.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name), overwrite, stats);
    return;
  }
  if (d?.isDirectory()) throw new FileError(`Nella destinazione c'è una cartella al posto di un file: ${dst}`);
  if (!overwrite && d) { stats.kept++; return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // Copia in un file temporaneo e poi rinomina: chi legge non vede mai un file a metà (OneDrive compreso).
  const tmp = path.join(path.dirname(dst), `.${path.basename(dst)}.ciccio-tmp`);
  try {
    // Un temporaneo rimasto da prima (o un collegamento con quel nome) si toglie: la copia lo crea nuovo.
    fs.rmSync(tmp, { force: true });
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
    fs.utimesSync(tmp, s.atime, s.mtime);
    fs.renameSync(tmp, dst);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  stats.files++;
}

/**
 * Prima di sovrascrivere `dst` (che esiste): se la sua cartella consentita ha un backup, ci copia la versione di adesso.
 * Stesso percorso relativo alla root; se c'è già una copia di quel file nel backup, resta la più vecchia.
 */
export function backupExisting(roots: ResolvedRoot[], dst: { real: string; root: ResolvedRoot }): string | undefined {
  const bk = dst.root.backup;
  if (!bk || isInside(bk, dst.real)) return undefined;
  const backedUp = path.join(bk, path.relative(dst.root.real, dst.real));
  const inBackup = resolveInside([dst.root], backedUp);
  if (!isInside(bk, inBackup.real)) throw new FileError(`Il backup uscirebbe dalla sua cartella: ${backedUp}`);
  assertWritable(roots, inBackup.real);
  assertNoLinksAt(dst.real, inBackup.real);
  copyTree(dst.real, inBackup.real, false, { files: 0, skippedLinks: 0, kept: 0 });
  return backedUp;
}

/**
 * Dove scrivere un file nuovo (scarica_da_ciccio, l'uscita di un comando): in una cartella scrivibile, mai sopra un
 * collegamento o una cartella, e sopra un file che c'è già solo con `overwrite`. Crea le cartelle che mancano.
 */
export function prepareFileWrite(roots: ResolvedRoot[], to: string, overwrite: boolean): { real: string; root: ResolvedRoot; exists: boolean } {
  const dst = resolveWritable(roots, to);
  if (norm(dst.real) === norm(dst.root.real)) throw new FileError(`Indica il percorso completo del file, non la cartella consentita: ${to}`);
  const d = lstatOrNull(dst.real);
  if (d) {
    if (d.isSymbolicLink()) throw new FileError(`La destinazione è un collegamento, non ci scrivo: ${to}`);
    if (!d.isFile()) throw new FileError(`Nella destinazione c'è una cartella: ${to}\nIndica il percorso completo del file.`);
    if (!overwrite) throw new FileError(`La destinazione esiste già: ${to}\nPer sostituirla passa sovrascrivi=true.`);
  }
  fs.mkdirSync(path.dirname(dst.real), { recursive: true });
  return { ...dst, exists: !!d };
}

/** Un file temporaneo accanto a `real`: chi legge non vede mai un file a metà. */
const tempNear = (real: string) => path.join(path.dirname(real), `.${path.basename(real)}.ciccio-tmp`);

export function copyPath(roots: ResolvedRoot[], from: string, to: string, overwrite: boolean) {
  const src = resolveInside(roots, from);
  const dst = resolveWritable(roots, to);
  let ss: fs.Stats;
  try { ss = fs.statSync(src.real); } catch { throw new FileError(`L'origine non esiste: ${from}`); }
  if (!ss.isFile() && !ss.isDirectory()) throw new FileError(`L'origine non è un file né una cartella: ${from}`);
  if (norm(src.real) === norm(dst.real)) throw new FileError('Origine e destinazione sono lo stesso percorso.');
  if (ss.isDirectory() && isInside(src.real, dst.real)) throw new FileError('La destinazione sta dentro la cartella da copiare.');
  if (isInside(dst.real, src.real)) throw new FileError('L\'origine sta dentro la destinazione: copiarla la sovrascriverebbe.');

  let ds: fs.Stats | null = null;
  try { ds = fs.lstatSync(dst.real); } catch { /* non esiste */ }
  let backedUp: string | undefined;
  if (ds) {
    if (!overwrite) throw new FileError(`La destinazione esiste già: ${to}\nPer sostituirla passa sovrascrivi=true.`);
    if (ds.isSymbolicLink()) throw new FileError(`La destinazione è un collegamento simbolico, non lo sovrascrivo: ${to}`);
    if (ds.isDirectory() !== ss.isDirectory()) throw new FileError(`Origine e destinazione sono di tipo diverso (file e cartella): ${to}`);
    assertNoLinksAt(src.real, dst.real);
    backedUp = backupExisting(roots, dst);
  }
  const stats = { files: 0, skippedLinks: 0, kept: 0 };
  copyTree(src.real, dst.real, true, stats);
  return {
    copiato: src.real, in: dst.real, file: stats.files,
    ...(ds ? { sovrascritto: true } : {}),
    ...(backedUp ? { backup: backedUp } : {}),
    ...(stats.skippedLinks ? { collegamentiSaltati: stats.skippedLinks } : {}),
  };
}

export function makeDir(roots: ResolvedRoot[], p: string) {
  const { real: abs } = resolveWritable(roots, p);
  const existed = fs.existsSync(abs);
  if (existed && !fs.statSync(abs).isDirectory()) throw new FileError(`Esiste già un file con questo nome: ${p}`);
  fs.mkdirSync(abs, { recursive: true });
  return { cartella: abs, creata: !existed };
}

const text = (o: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) }] });
const fail = (e: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: e instanceof FileError ? e.message : `Errore: ${(e as NodeJS.ErrnoException).code ?? ''} ${(e as Error).message}`.trim() }],
});

export interface AccessRequest {
  /** Percorso reale della cartella chiesta. */
  cartella: string;
  esiste: boolean;
  solaLettura: boolean;
  /** Scritto dall'agente: si mostra come tale, non conferma niente. */
  motivo: string;
  timeoutMs: number;
}
/** La scelta fatta sul PC. `solaLettura` può non essere quella chiesta: decide chi è davanti al PC. */
export type AccessAnswer = { scelta: 'una_volta' | 'sempre'; solaLettura: boolean } | { scelta: 'no' } | { scelta: 'nessuna_risposta' };

/** Come il companion parla con Ciccio per scarica_da_ciccio e carica_su_ciccio (transfer.ts). */
export interface TransferClient {
  /** Scarica in `file` il file che Ciccio ha preparato per questa chiamata. */
  download(t: TransferParams, file: string, signal: AbortSignal): Promise<{ dimensione: number; sha256: string }>;
  /** Manda a Ciccio il contenuto di un file per la destinazione preparata. */
  upload(t: TransferParams, data: Buffer, signal: AbortSignal): Promise<{ percorso: string; dimensione: number; sha256: string }>;
}

export interface FileServerOptions {
  /** Mostra la richiesta sul PC (finestra del companion). Senza, chiedi_accesso non c'è. Con `signal` interrotto la finestra si chiude. */
  ask?: (req: AccessRequest, signal: AbortSignal) => Promise<AccessAnswer>;
  /** «Consenti sempre»: salva la cartella nella config del PC (stessa cartella già presente: la sostituisce). */
  persist?: (root: { path: string; solaLettura?: true }) => void;
  /** Cartelle cambiate: le istruzioni nuove, per Ciccio. */
  onChange?: (instructions: string) => void;
  /** Attesa della risposta (prove). */
  timeoutMs?: number;
  /** Cartelle consentite «questa volta», condivise con il server «comandi» (vedi activeRoots). */
  once?: Exclude<RootSpec, string>[];
  /** Scambio di file con il repo dell'agente su Ciccio. Senza, scarica_da_ciccio e carica_su_ciccio non ci sono. */
  transfer?: TransferClient;
}

/** Le cartelle consentite adesso: quelle della config e quelle «questa volta» non ancora scadute. */
export function activeRoots(specs: RootSpec[], once: Exclude<RootSpec, string>[] = []): RootSpec[] {
  const now = Date.now();
  return [...specs, ...once.filter((s) => s.finoA! > now)];
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} secondi` : `${Math.round(ms / 60_000)} minuti`);
const specPath = (s: RootSpec) => path.resolve(expandPath(typeof s === 'string' ? s : s.path));
const sameRoot = (s: RootSpec, real: string) => { try { return norm(realpathLoose(specPath(s))) === norm(real); } catch { return false; } };

/**
 * Il server MCP «file». Le root si risolvono a ogni chiamata: una cartella creata o un collegamento cambiato dopo l'avvio contano.
 * `specs` è l'elenco vivo della voce di config: «Consenti sempre» di chiedi_accesso ci aggiunge la cartella.
 */
export function createFileServer(specs: RootSpec[], opts: FileServerOptions = {}): McpServer {
  /** Cartelle consentite «questa volta»: solo in memoria, scadono. */
  const once = opts.once ?? [];
  const live = (): RootSpec[] => activeRoots(specs, once);
  const rootsNow = () => resolveRoots(live());
  const label = (s: RootSpec) => {
    const o = typeof s === 'string' ? { path: s } : s;
    const notes = [
      o.solaLettura ? 'sola lettura: si copia da qui verso le altre, dentro non si scrive' : '',
      o.backup && !o.solaLettura ? `backup prima di sovrascrivere: ${o.backup}` : '',
      o.finoA ? `consentita fino alle ${hhmm(o.finoA)}` : '',
    ].filter(Boolean);
    return `- ${specPath(s)}${notes.length ? ` (${notes.join('; ')})` : ''}`;
  };
  const instructions = () => [
    'Copia di file e cartelle tra le cartelle consentite di questo PC (niente cancellazioni, niente lettura del contenuto). Percorsi assoluti (anche con ~ o %VARIABILE%).',
    live().length
      ? `Cartelle consentite:\n${live().map(label).join('\n')}`
      : opts.ask ? NO_ROOTS : 'Nessuna cartella consentita: si aggiungono nella config del PC (roots).',
    ...(opts.ask ? [`Per una cartella che non è ${live().length ? 'nell\'elenco' : 'ancora consentita'}, o per scrivere in una in sola lettura: chiedi_accesso. Decide chi è davanti al PC; senza risposta è no.`] : []),
    ...(opts.transfer ? [`File tra il repo del tuo progetto su Ciccio e queste cartelle: ${TRANSFER_TOOLS.download.tool} (dal repo al PC) e ${TRANSFER_TOOLS.upload.tool} (dal PC al repo).`] : []),
  ].join('\n');
  /** Per le descrizioni degli strumenti che scrivono. */
  const readOnlyNote = () => {
    const ro = live().filter((s) => typeof s !== 'string' && s.solaLettura).map(specPath);
    return ro.length ? ` Le cartelle in sola lettura fanno solo da origine, dentro non si scrive: ${ro.join('; ')}.` : '';
  };

  const server = new McpServer({ name: 'ciccio-companion-file', version: '1' }, { instructions: instructions() });
  const run = <T>(f: () => T): CallToolResult => { try { return text(f() as unknown); } catch (e) { return fail(e); } };

  server.registerTool('elenca', {
    description: 'Elenca il contenuto di una cartella consentita (nome, tipo, dimensione, data di modifica). Senza percorso mostra le cartelle consentite, con quelle in sola lettura. I collegamenti simbolici non si seguono.',
    inputSchema: {
      percorso: z.string().optional().describe('Cartella da elencare (assoluta). Se manca: le cartelle consentite.'),
      ricorsivo: z.boolean().optional().describe('Scende nelle sottocartelle (default false).'),
      limite: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe(`Massimo di voci (default ${DEFAULT_LIST_LIMIT}, massimo ${MAX_LIST_LIMIT}).`),
    },
    annotations: { readOnlyHint: true },
  }, ({ percorso, ricorsivo, limite }) => run(() => percorso
    ? listDir(rootsNow(), percorso, ricorsivo ?? false, limite ?? DEFAULT_LIST_LIMIT)
    : { cartelleConsentite: rootsNow().map((r) => ({
      percorso: r.real, esiste: fs.existsSync(r.real),
      ...(r.readOnly ? { solaLettura: true } : {}), ...(r.backup ? { backup: r.backup } : {}), ...(r.until ? { finoAlle: hhmm(r.until) } : {}),
    })), ...(live().length ? {} : { nota: opts.ask ? NO_ROOTS : 'Nessuna cartella consentita.' }) }));

  server.registerTool('info', {
    description: 'Dice se un percorso esiste e di che tipo è (file, cartella, collegamento), con dimensione e data di modifica.',
    inputSchema: { percorso: z.string().describe('Percorso assoluto, dentro una cartella consentita.') },
    annotations: { readOnlyHint: true },
  }, ({ percorso }) => run(() => pathInfo(rootsNow(), percorso)));

  const copyDesc = 'Copia un file o una cartella (ricorsivo) da una cartella consentita a un\'altra, creando le cartelle di destinazione. `a` è il percorso completo della copia, non la cartella che la contiene, e deve stare in una cartella scrivibile. Se la destinazione esiste dà errore, salvo sovrascrivi=true; in quel caso, se la cartella consentita ha un backup configurato, la versione esistente vi viene copiata prima (stesso percorso relativo; se nel backup c\'è già una versione più vecchia, resta quella). I collegamenti simbolici dentro una cartella non si copiano.';
  const copyTool = server.registerTool('copia', {
    description: copyDesc + readOnlyNote(),
    inputSchema: {
      da: z.string().describe('File o cartella di origine (assoluto).'),
      a: z.string().describe('Percorso completo di destinazione (assoluto), in una cartella scrivibile.'),
      sovrascrivi: z.boolean().optional().describe('true per sostituire una destinazione che esiste già (default false).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, ({ da, a, sovrascrivi }) => run(() => copyPath(rootsNow(), da, a, sovrascrivi === true)));

  const mkdirDesc = 'Crea una cartella (con le intermedie) dentro una cartella consentita scrivibile. Se esiste già non fa nulla.';
  const mkdirTool = server.registerTool('crea_cartella', {
    description: mkdirDesc + readOnlyNote(),
    inputSchema: { percorso: z.string().describe('Cartella da creare (assoluta).') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, ({ percorso }) => run(() => makeDir(rootsNow(), percorso)));

  if (opts.transfer) {
    const transfer = opts.transfer;
    const mb = `${MAX_TRANSFER_BYTES / 1024 / 1024} MB`;
    /** Il file che Ciccio ha preparato per questa chiamata (token monouso): senza, lo strumento non fa niente. */
    const prepared = (meta: Record<string, unknown> | undefined, verso: TransferKind): TransferParams => {
      const t = meta?.[TRANSFER_META] as TransferParams | undefined;
      if (!t || typeof t !== 'object' || t.verso !== verso || typeof t.token !== 'string') throw new FileError('Ciccio non ha preparato il file per questa chiamata (forse il server di Ciccio è da aggiornare).');
      return t;
    };

    server.registerTool(TRANSFER_TOOLS.download.tool, {
      description: `Porta su questo PC un file del repo del tuo progetto su Ciccio (es. un STL fatto con OpenSCAD), in una cartella consentita scrivibile. ${TRANSFER_TOOLS.download.repoArg} è relativo alla radice del repo; destinazione è il percorso completo del file sul PC. Se la destinazione esiste dà errore, salvo sovrascrivi=true (con backup, se la cartella ne ha uno). Massimo ${mb}.`,
      inputSchema: {
        [TRANSFER_TOOLS.download.repoArg]: z.string().describe('File nel repo del progetto, relativo alla radice del repo.'),
        destinazione: z.string().describe('Percorso completo del file sul PC (assoluto), in una cartella scrivibile.'),
        sovrascrivi: z.boolean().optional().describe('true per sostituire un file che esiste già (default false).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { [TRANSFER_META]: 'download' },
    }, async (args, extra) => {
      const { destinazione, sovrascrivi } = args as { destinazione: string; sovrascrivi?: boolean };
      let tmp = '';
      try {
        const t = prepared(extra._meta, 'download');
        const dst = prepareFileWrite(rootsNow(), destinazione, sovrascrivi === true);
        tmp = tempNear(dst.real);
        fs.rmSync(tmp, { force: true });
        const got = await transfer.download(t, tmp, extra.signal);
        // Di nuovo dopo l'attesa: nel frattempo la destinazione o le cartelle possono essere cambiate.
        const roots = rootsNow();
        const again = prepareFileWrite(roots, destinazione, sovrascrivi === true);
        if (norm(again.real) !== norm(dst.real)) throw new FileError(`La destinazione è cambiata durante lo scaricamento: ${destinazione}`);
        const backup = again.exists ? backupExisting(roots, again) : undefined;
        fs.renameSync(tmp, again.real);
        return text({ scaricato: t.percorso, in: again.real, dimensione: got.dimensione, sha256: got.sha256, ...(again.exists ? { sovrascritto: true } : {}), ...(backup ? { backup } : {}) });
      } catch (e) { return fail(e); } finally { if (tmp) fs.rmSync(tmp, { force: true }); }
    });

    server.registerTool(TRANSFER_TOOLS.upload.tool, {
      description: `Porta un file di questo PC (da una cartella consentita, anche in sola lettura) nel repo del tuo progetto su Ciccio. ${TRANSFER_TOOLS.upload.repoArg} è relativo alla radice del repo (mai dentro .git); se esiste dà errore, salvo sovrascrivi=true. Massimo ${mb}.`,
      inputSchema: {
        file_sul_pc: z.string().describe('File sul PC (assoluto), dentro una cartella consentita.'),
        [TRANSFER_TOOLS.upload.repoArg]: z.string().describe('Percorso del file nel repo del progetto, relativo alla radice del repo.'),
        sovrascrivi: z.boolean().optional().describe('true per sostituire un file del repo che esiste già (default false).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { [TRANSFER_META]: 'upload' },
    }, async (args, extra) => {
      const { file_sul_pc } = args as { file_sul_pc: string };
      try {
        const t = prepared(extra._meta, 'upload');
        const src = resolveInside(rootsNow(), file_sul_pc);
        const st = lstatOrNull(src.real);
        if (!st) throw new FileError(`Il file non esiste: ${file_sul_pc}`);
        if (!st.isFile()) throw new FileError(`Non è un file: ${file_sul_pc}`);
        const max = Math.min(t.massimo ?? MAX_TRANSFER_BYTES, MAX_TRANSFER_BYTES);
        if (st.size > max) throw new FileError(`File troppo grande (${st.size} byte, massimo ${max}).`);
        const res = await transfer.upload(t, fs.readFileSync(src.real), extra.signal);
        return text({ caricato: src.real, nelRepo: res.percorso, dimensione: res.dimensione, sha256: res.sha256 });
      } catch (e) { return fail(e); }
    });
  }

  /** Cartelle cambiate (aggiunte o scadute): istruzioni e descrizioni nuove, che arrivano subito a Ciccio. */
  const changed = () => {
    for (let i = once.length - 1; i >= 0; i--) if (once[i].finoA! <= Date.now()) once.splice(i, 1);
    opts.onChange?.(instructions());
    copyTool.update({ description: copyDesc + readOnlyNote() });
    mkdirTool.update({ description: mkdirDesc + readOnlyNote() });
  };

  if (opts.ask) {
    const ask = opts.ask;
    const timeoutMs = opts.timeoutMs ?? ACCESS_TIMEOUT_MS;
    let pending = false;
    /** Cartelle appena rifiutate sul PC → fino a quando si rifiutano da sole. */
    const refused = new Map<string, number>();

    const requestAccess = async (cartella: string, solaLettura: boolean, motivo: string, signal: AbortSignal) => {
      const real = toReal(cartella);
      if (path.dirname(real) === real) throw new FileError(`Cartella troppo ampia (${real}): chiedi quella precisa che serve.`);
      assertNotCompanionDir(real, `La cartella ${real}`);
      let st: fs.Stats | null = null;
      try { st = fs.statSync(real); } catch { /* può non esistere ancora */ }
      if (st && !st.isDirectory()) throw new FileError(`Non è una cartella: ${cartella}`);
      const have = rootOf(rootsNow(), real);
      if (have && (solaLettura || !have.readOnly)) return { esito: 'già consentita', cartella: real, dentro: have.label, solaLettura: have.readOnly };
      const key = norm(real);
      if ((refused.get(key) ?? 0) > Date.now()) throw new FileError(`L'accesso a ${real} è stato rifiutato sul PC poco fa: non chiederlo di nuovo adesso.`);
      if (pending) throw new FileError('Sul PC c\'è già una richiesta di accesso in attesa di risposta: aspetta e riprova.');

      pending = true;
      const ctrl = new AbortController();
      const stop = () => ctrl.abort();
      const timer = setTimeout(stop, timeoutMs);
      signal.addEventListener('abort', stop);
      let answer: AccessAnswer;
      try {
        // Tempo scaduto (o chiamata annullata): la finestra si chiude e la risposta è «nessuna risposta».
        const gone = new Promise<AccessAnswer>((resolve) => ctrl.signal.addEventListener('abort', () => resolve({ scelta: 'nessuna_risposta' })));
        const req: AccessRequest = { cartella: real, esiste: st != null, solaLettura, motivo: motivo.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300), timeoutMs };
        answer = await Promise.race([ask(req, ctrl.signal), gone]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        ctrl.abort();
        pending = false;
      }

      if (answer.scelta === 'no') {
        refused.set(key, Date.now() + REFUSED_MS);
        return { esito: 'rifiutata', cartella: real, nota: 'Sul PC hanno risposto no: non richiederla adesso; continua senza o chiedi in chat.' };
      }
      if (answer.scelta === 'nessuna_risposta') {
        return { esito: 'nessuna risposta', cartella: real, nota: `Nessuna risposta sul PC entro ${duration(timeoutMs)} (forse non c'è nessuno): l'accesso non è stato dato. Riprova più tardi o chiedi in chat.` };
      }
      const spec = { path: real, ...(answer.solaLettura ? { solaLettura: true as const } : {}) };
      // Una scelta nuova sulla stessa cartella sostituisce quella di prima.
      for (let i = once.length - 1; i >= 0; i--) if (sameRoot(once[i], real)) once.splice(i, 1);
      let saved = false;
      let problem = '';
      if (answer.scelta === 'sempre' && opts.persist) {
        try { opts.persist(spec); saved = true; } catch (e) { problem = `Non salvata nella config del PC (${(e as Error).message}): vale solo come «questa volta».`; }
      }
      const until = Date.now() + ONCE_MS;
      if (saved) {
        const i = specs.findIndex((s) => sameRoot(s, real));
        if (i >= 0) specs[i] = spec; else specs.push(spec);
      } else {
        once.push({ ...spec, finoA: until });
        setTimeout(changed, ONCE_MS + 1000).unref();
      }
      changed();
      return {
        esito: 'consentita', cartella: real, solaLettura: answer.solaLettura,
        valida: saved ? 'sempre (salvata nella config del PC)' : `fino alle ${hhmm(until)}, o finché il companion resta acceso`,
        ...(answer.solaLettura !== solaLettura ? { nota: answer.solaLettura ? 'Concessa solo in lettura: dentro non si scrive.' : 'Concessa anche in scrittura.' } : {}),
        ...(problem ? { problema: problem } : {}),
      };
    };

    server.registerTool('chiedi_accesso', {
      description: `Chiede a chi è davanti al PC di consentire una cartella che non è tra quelle consentite (o di scrivere in una in sola lettura). Sul PC compare una finestra con cartella, tipo di accesso e motivo: «Consenti questa volta» (finché il companion resta acceso, al massimo ${ONCE_MS / 3_600_000} ore), «Consenti sempre» (resta nella config del PC) o «No». Senza risposta entro ${duration(timeoutMs)}: nessuna risposta, cioè niente accesso. Chiedi la cartella più precisa che serve, in sola lettura se devi solo copiarne i file altrove. Una cartella rifiutata non si richiede subito.`,
      inputSchema: {
        cartella: z.string().describe('Cartella da consentire (assoluta, anche con ~ o %VARIABILE%).'),
        solaLettura: z.boolean().describe('true se basta elencarla e copiarne i file verso altre cartelle; false per scriverci dentro.'),
        motivo: z.string().min(1).max(300).describe('Perché serve, in una frase: lo legge chi decide sul PC.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ cartella, solaLettura, motivo }, extra) => {
      try { return text(await requestAccess(cartella, solaLettura, motivo, extra.signal)); } catch (e) { return fail(e); }
    });
  }

  return server;
}
