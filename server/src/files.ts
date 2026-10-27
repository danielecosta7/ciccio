import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DiffFile } from '../../shared/types.js';
import { gitSync } from './git.js';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic',
  pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
  csv: 'text/csv; charset=utf-8', tsv: 'text/tab-separated-values; charset=utf-8',
  json: 'application/json; charset=utf-8', html: 'text/plain; charset=utf-8', htm: 'text/plain; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  stl: 'model/stl', obj: 'model/obj', '3mf': 'model/3mf',
  zip: 'application/zip',
};

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yml', 'yaml', 'toml', 'ini', 'env', 'css', 'scss',
  'html', 'htm', 'xml', 'svg', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'php', 'sh', 'bash', 'zsh', 'sql', 'c', 'h',
  'cpp', 'hpp', 'cs', 'vue', 'svelte', 'astro', 'lock', 'gitignore', 'dockerfile', 'conf', 'log', 'csv', 'tsv',
]);

/** Tipo per la vista "renderizzata" (HTML vero, in una sandbox senza origine). */
export function viewMimeFor(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'text/html; charset=utf-8';
  if (ext === 'css') return 'text/css; charset=utf-8';
  if (['js', 'mjs'].includes(ext)) return 'text/javascript; charset=utf-8';
  return mimeFor(file);
}

// Le pagine HTML girano in una sandbox senza origine: il cookie di accesso non arriva.
// I loro file (CSS, script, immagini relative) passano allora da un indirizzo firmato, valido un'ora e per una sola
// cartella: quella della pagina, dentro il repo (o il worktree) della chat. Chi trovasse l'indirizzo (una pagina che
// lo manda fuori) vede quella cartella e le sue sottocartelle, mai i file nascosti, il resto del repo o la home.
const VIEW_SECRET = randomBytes(32);
const VIEW_TTL_S = 3600;
const signView = (who: string, scope: string, exp: number) => createHmac('sha256', VIEW_SECRET).update(`view.${who}.${scope}.${exp}`).digest('base64url').slice(0, 32);

/** `who`: «progetto» o «progetto~chat»; `scope`: la cartella della pagina, relativa alla cartella della chat ('' = la radice). */
export function viewToken(who: string, scope: string): string {
  const exp = Math.floor(Date.now() / 1000) + VIEW_TTL_S;
  return `${Buffer.from(scope).toString('base64url')}.${exp}.${signView(who, scope, exp)}`;
}

/** La cartella firmata nel token, o null se il token è falso, scaduto o di un'altra chat. */
export function checkViewToken(who: string, token: string): string | null {
  const [p = '', e, sig] = token.split('.');
  const exp = Number(e);
  if (!exp || !sig || exp < Date.now() / 1000) return null;
  const scope = Buffer.from(p, 'base64url').toString();
  const want = Buffer.from(signView(who, scope, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? scope : null;
}

/** La cartella da firmare per l'anteprima viva di `abs` (già passato da viewablePath): relativa a `dir`, o null se è fuori. */
export function viewScope(dir: string, abs: string): string | null {
  const root = real(dir);
  if (!root) return null;
  const r = path.relative(root, path.dirname(abs));
  if (r.startsWith('..') || path.isAbsolute(r)) return null;
  return r.split(path.sep).join('/');
}

/** Un file della pagina dentro la cartella firmata: niente ../, niente nascosti sotto di lei, niente collegamenti che escono. */
export function viewInScope(dir: string, scope: string, rel: string): string | null {
  const root = real(dir);
  if (!root) return null;
  const base = path.resolve(root, scope);
  if (base !== root && !inside(root, base)) return null;
  const abs = path.resolve(base, rel);
  if (!inside(base, abs) || hidden(path.relative(base, abs))) return null;
  const target = real(abs);
  if (!target || !inside(base, target) || hidden(path.relative(base, target))) return null;
  return path.relative(root, target).split(path.sep)[0] === '.git' ? null : target;
}

// Visore di Office online (facoltativo, Impostazioni › Chat): scarica il file da sé, da internet. Gli si dà un
// indirizzo firmato per quel solo file (percorso reale, assoluto), valido mezz'ora, con il nome in fondo (Office ne
// legge l'estensione).
const OFFICE_TTL_S = 30 * 60;
const signFile = (agentId: string, file: string, exp: number) => createHmac('sha256', VIEW_SECRET).update(`file.${agentId}.${file}.${exp}`).digest('base64url').slice(0, 32);

export function fileToken(agentId: string, file: string): string {
  const exp = Math.floor(Date.now() / 1000) + OFFICE_TTL_S;
  return `${Buffer.from(file).toString('base64url')}.${exp}.${signFile(agentId, file, exp)}`;
}

/** Il file firmato nel token, se è ancora proprio lì (non sostituito da un collegamento simbolico), o null. */
export function checkFileToken(agentId: string, token: string): string | null {
  const [p, e, sig] = token.split('.');
  const exp = Number(e);
  if (!p || !exp || !sig || exp < Date.now() / 1000) return null;
  const file = Buffer.from(p, 'base64url').toString();
  const want = Buffer.from(signFile(agentId, file, exp));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return real(file) === file ? file : null;
}

export function mimeFor(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  if (TEXT_EXT.has(ext) || !ext) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function git(repo: string, args: string[], max = 8 * 1024 * 1024): string {
  return gitSync(['-C', repo, ...args], { timeout: 15000, maxBuffer: max });
}

const inside = (root: string, p: string) => { const r = path.relative(root, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
const hidden = (rel: string) => rel.split(path.sep).some((s) => s.startsWith('.'));
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return null; } };

/**
 * Un percorso dentro al repo (niente ../ e niente .git), oppure null. Conta dove arriva davvero: un collegamento
 * simbolico nel repo può puntare ovunque (file nascosti, dati di Ciccio). Se il file c'è si restituisce il percorso
 * reale, e solo se resta dentro al repo; se non c'è, il percorso com'è (chi chiama lo trova mancante).
 */
export function safePath(repo: string, rel: string): string | null {
  const abs = path.resolve(repo, rel);
  const r = path.relative(repo, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r) || r.split(path.sep)[0] === '.git') return null;
  const target = real(abs);
  if (!target) return abs;
  const root = real(repo);
  if (!root || !inside(root, target) || path.relative(root, target).split(path.sep)[0] === '.git') return null;
  return target;
}

/**
 * Un file da mostrare nell'anteprima (con l'accesso), come lo nomina l'agente: relativo al repo, assoluto o con ~/.
 * Fuori dal repo vale solo sotto la home o /tmp e mai dentro cartelle o file nascosti (chiavi, configurazioni, database
 * di Ciccio), né nel percorso scritto né dove arriva seguendo i collegamenti simbolici.
 */
export function viewablePath(repo: string, p: string): string | null {
  const home = os.homedir();
  let abs: string;
  if (p.startsWith('~/')) abs = path.resolve(home, p.slice(2));
  else if (path.isAbsolute(p)) abs = path.resolve(p);
  else return safePath(repo, p);
  if (inside(repo, abs)) return safePath(repo, path.relative(repo, abs));
  for (const root of [home, '/tmp']) {
    if (!inside(root, abs) || hidden(path.relative(root, abs))) continue;
    const target = real(abs);
    if (!target) return abs;
    const base = real(root);
    return base && inside(base, target) && !hidden(path.relative(base, target)) ? target : null;
  }
  return null;
}

export function tree(repo: string): string[] {
  let files: string[] = [];
  try { files = git(repo, ['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean).slice(0, 5000); } catch { /* non è un repo git */ }
  // .ciccio/ è escluso da git ma ci sono i file di lavoro degli agenti e gli allegati: li mostro in cima.
  return [...ciccioFiles(repo), ...files];
}

function ciccioFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(repo, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 500) return;
      const p = `${rel}/${e.name}`;
      if (e.isDirectory() && depth < 6) walk(p, depth + 1);
      else if (e.isFile()) out.push(p);
    }
  };
  walk('.ciccio/out', 0);
  walk('.ciccio/uploads', 0);
  return out;
}

export function branch(repo: string): string | null {
  try { return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || null; } catch { return null; }
}

export function mcpServers(repo: string): string[] {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    return Object.keys(cfg.mcpServers ?? {});
  } catch {
    return [];
  }
}

function baseRef(repo: string): string | null {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    try {
      git(repo, ['rev-parse', '--verify', '--quiet', ref]);
      return git(repo, ['merge-base', ref, 'HEAD']).trim();
    } catch { /* prova il prossimo */ }
  }
  return null;
}

/** Modifiche del lavoro dell'agente: rispetto al branch principale, file non salvati compresi. */
export function diff(repo: string): { base: string | null; files: DiffFile[] } {
  const base = baseRef(repo);
  const files: DiffFile[] = [];
  try {
    const against = base ?? 'HEAD';
    const numstat = git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', against]).split('\n').filter(Boolean);
    let budget = 400_000;
    for (const line of numstat.slice(0, 200)) {
      const [a, r, ...rest] = line.split('\t');
      const file = rest.join('\t');
      let patch = '';
      if (budget > 0) {
        patch = git(repo, ['diff', '--no-ext-diff', '--no-textconv', against, '--', file]).slice(0, 60_000);
        budget -= patch.length;
      }
      files.push({ path: file, added: Number(a) || 0, removed: Number(r) || 0, patch });
    }
    for (const file of git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).slice(0, 100)) {
      files.push({ path: file, added: 0, removed: 0, patch: '' });
    }
  } catch { /* repo senza commit o diff non disponibile */ }
  return { base, files };
}

/** Cartella degli allegati: dentro al repo ma esclusa da git. */
/** .ciccio/ (allegati, file di lavoro degli agenti) non finisce mai in git: solo esclusione locale, il repo non cambia. */
export function ignoreCiccioDir(repo: string) {
  const exclude = path.join(repo, '.git', 'info', 'exclude');
  try {
    if (!fs.existsSync(path.dirname(exclude))) return;
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!cur.split('\n').includes('.ciccio/')) fs.appendFileSync(exclude, `${cur.endsWith('\n') || !cur ? '' : '\n'}.ciccio/\n`);
  } catch { /* non bloccante */ }
}

export function uploadsDir(repo: string): string {
  const dir = path.join(repo, '.ciccio', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  ignoreCiccioDir(repo);
  return dir;
}

export function safeFileName(name: string): string {
  const base = path.basename(name).normalize('NFKD').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '-').slice(0, 120);
  return base || 'file';
}

/**
 * Manda un file rispettando le richieste di un pezzo (Range): i video e gli audio si possono scorrere e far partire
 * da metà, e il browser non scarica tutto per mostrare un punto preciso. Senza Range, il file intero (con la lunghezza).
 */
export function sendFile(req: FastifyRequest, reply: FastifyReply, abs: string, type: string) {
  const size = fs.statSync(abs).size;
  reply.header('Accept-Ranges', 'bytes').type(type);
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
  if (!m || (!m[1] && !m[2])) return reply.header('Content-Length', size).send(fs.createReadStream(abs));
  // «bytes=-N» sono gli ultimi N byte; «bytes=A-» da A alla fine.
  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  end = Math.min(end, size - 1);
  if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
  start = Math.max(0, start);
  return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1)
    .send(fs.createReadStream(abs, { start, end }));
}
