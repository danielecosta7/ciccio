import fs from 'node:fs';
import path from 'node:path';
import { IDLE_GAP_MS, KEEP_DAYS, addBucket, bucketKey, emptyBucket, modelWeight, rawW, zoneDay, shortModel, splitKey, type UsageBucket, type UsageBuckets } from '../consumi.js';

// Lettura incrementale dei transcript di Claude Code (~/.claude/projects/<cartella>/<sessione>.jsonl) per i consumi
// (shared/consumi.ts). Ogni file si legge una volta: la cache tiene, per file, fin dove è arrivata la lettura e i
// secchi che ne sono usciti; ai giri dopo si leggono solo le righe aggiunte. Usata da Ciccio sul server e dal
// companion sui PC (lì non esce niente dal PC se non i secchi).

export type Origin = 'utente' | 'auto';

export interface ScannerOptions {
  /** Cartella dei transcript (~/.claude/projects). */
  root: string;
  /** File JSON della cache. */
  cacheFile: string;
  /** Nome del progetto da mostrare per una cartella dei transcript. */
  project: (dir: string) => string;
  /** Chi ha mandato un prompt (sul PC: sempre l'utente). */
  origin?: (p: { sessionId: string; ts: number; text: string }) => Origin;
  /** Le righe più recenti di così restano per la lettura dopo (sul server il giro si registra un attimo dopo il prompt). */
  holdMs?: number;
}

interface FileState {
  size: number;
  offset: number;
  /** Cartella dei transcript: il nome del progetto si calcola quando si leggono i secchi (vale anche dopo una rinomina). */
  dir: string;
  /** Ultimo evento della sessione (per il tempo attivo tra una lettura e l'altra). */
  lastT: number;
  /** Chi ha mandato l'ultimo prompt: le chiamate dopo sono sue. */
  origin: Origin;
  /** Impronte delle chiamate e dei prompt contati da questo file (gli altri file non li ricontano). */
  claims: number[];
  /** Secchi per `giorno	` (il progetto lo aggiunge buckets()). */
  buckets: UsageBuckets;
}

interface Cache { version: number; files: Record<string, FileState> }

const CACHE_VERSION = 2;
const CHUNK = 4 * 1024 * 1024;

/** Impronta a 53 bit di una stringa (cyrb53): basta per riconoscere le chiamate già contate. */
function hash(s: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

type Line = {
  type?: string; isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean; sessionId?: string; uuid?: string; timestamp?: string; requestId?: string;
  message?: { id?: string; model?: string; content?: unknown; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number } } };
};

/** Testo di un prompt scritto da una persona, o null (risultati di strumenti, comandi locali, promemoria, sub-agent). */
function humanText(o: Line): string | null {
  if (o.type !== 'user' || o.isSidechain || o.isMeta || o.isCompactSummary) return null;
  const c = o.message?.content;
  if (typeof c === 'string') return /^\s*<(local-command|command-|system-reminder|task-notification)/.test(c) ? null : c;
  if (!Array.isArray(c)) return null;
  const blocks = c as { type?: string; text?: string }[];
  if (blocks.some((b) => b.type === 'tool_result')) return null;
  const texts = blocks.filter((b) => b.type === 'text' && !/^\s*<(system-reminder|task-notification|local-command)/.test(b.text ?? ''));
  return texts.length ? texts.map((b) => b.text ?? '').join('\n') : null;
}

const pause = () => new Promise<void>((r) => setImmediate(r));

export class TranscriptScanner {
  private files: Record<string, FileState> = {};
  /** Impronta → file che l'ha contata. */
  private owner = new Map<number, string>();
  private running: Promise<void> | null = null;
  private dirty = false;
  updatedAt: number | null = null;
  /** true finché la prima lettura completa non è finita. */
  scanning = true;

  constructor(private opts: ScannerOptions) {
    try {
      const c = JSON.parse(fs.readFileSync(opts.cacheFile, 'utf8')) as Cache;
      if (c.version === CACHE_VERSION) this.files = c.files;
    } catch { /* niente cache: si legge tutto */ }
    for (const [f, s] of Object.entries(this.files)) for (const h of s.claims) this.owner.set(h, f);
  }

  /** Secchi di tutti i file, uniti. */
  buckets(): UsageBuckets {
    const out: UsageBuckets = {};
    const names = new Map<string, string>();
    for (const s of Object.values(this.files)) {
      let name = names.get(s.dir);
      if (name == null) { name = this.opts.project(s.dir); names.set(s.dir, name); }
      for (const [k, b] of Object.entries(s.buckets)) addBucket((out[bucketKey(splitKey(k).day, name)] ??= emptyBucket()), b);
    }
    return out;
  }

  /** Legge le righe nuove di tutti i transcript (una lettura alla volta: chi chiama durante aspetta quella in corso). */
  refresh(): Promise<void> {
    this.running ??= this.scan().finally(() => { this.running = null; });
    return this.running;
  }

  private async scan() {
    const since = Date.now() - KEEP_DAYS * 86_400_000;
    const seen = new Set<string>();
    const list: { file: string; dir: string; size: number; mtime: number }[] = [];
    let dirs: fs.Dirent[] = [];
    try { dirs = await fs.promises.readdir(this.opts.root, { withFileTypes: true }); } catch { /* Claude Code mai usato qui */ }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      for (const file of await this.jsonl(path.join(this.opts.root, d.name))) {
        try {
          const st = await fs.promises.stat(file);
          if (st.mtimeMs < since) continue;
          list.push({ file, dir: d.name, size: st.size, mtime: st.mtimeMs });
        } catch { /* sparito nel frattempo */ }
      }
    }
    // Dal più vecchio: una sessione ripresa in un file nuovo ricopia le chiamate di prima, che restano del file originale.
    list.sort((a, b) => a.mtime - b.mtime);
    for (const x of list) {
      seen.add(x.file);
      const prev = this.files[x.file];
      if (prev && prev.size === x.size) continue;
      await this.read(x.file, x.dir, x.size);
    }
    for (const f of Object.keys(this.files)) if (!seen.has(f)) { this.drop(f); }
    this.prune(zoneDay(since));
    this.updatedAt = Date.now();
    this.scanning = false;
    if (this.dirty) this.save();
  }

  /** File .jsonl di una cartella di progetto, anche nelle sottocartelle (i sub-agent stanno in <sessione>/subagents). */
  private async jsonl(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...await this.jsonl(p));
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
  }

  private drop(file: string) {
    const s = this.files[file];
    if (!s) return;
    for (const h of s.claims) if (this.owner.get(h) === file) this.owner.delete(h);
    delete this.files[file];
    this.dirty = true;
  }

  private prune(firstDay: string) {
    for (const s of Object.values(this.files)) {
      for (const k of Object.keys(s.buckets)) if (splitKey(k).day < firstDay) { delete s.buckets[k]; this.dirty = true; }
    }
  }

  private async read(file: string, dir: string, size: number) {
    // File riscritto più corto: si riparte da capo.
    const old = this.files[file];
    if (old && size < old.offset) this.drop(file);
    const s: FileState = (this.files[file] ??= { size: 0, offset: 0, dir, lastT: 0, origin: 'utente', claims: [], buckets: {} });
    const since = Date.now() - KEEP_DAYS * 86_400_000;
    const until = Date.now() - (this.opts.holdMs ?? 0);
    let held = false;
    const times: number[] = [];
    const claim = (key: string) => {
      const h = hash(key);
      if (this.owner.has(h)) return false;
      this.owner.set(h, file);
      s.claims.push(h);
      return true;
    };
    const bucket = (t: number): UsageBucket => (s.buckets[bucketKey(zoneDay(t), '')] ??= emptyBucket());

    const fh = await fs.promises.open(file, 'r');
    try {
      let pos = s.offset;
      let rest: Buffer = Buffer.alloc(0);
      let n = 0;
      while (pos < size && !held) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const data = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        // Posizione nel file del primo byte di data.
        const base = pos - data.length;
        let start = 0;
        for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
          const line = data.toString('utf8', start, nl);
          const lineStart = base + start;
          start = nl + 1;
          s.offset = base + start;
          if (++n % 2000 === 0) await pause();
          if (!line) continue;
          let o: Line;
          try { o = JSON.parse(line) as Line; } catch { continue; }
          const t = o.timestamp ? Date.parse(o.timestamp) : NaN;
          if (t > until) { s.offset = lineStart; held = true; break; }
          if (!t || t < since) continue;
          if (!o.isSidechain && (o.type === 'user' || o.type === 'assistant')) times.push(t);
          const text = humanText(o);
          if (text != null && (!o.uuid || claim(`p:${o.uuid}`))) {
            s.origin = this.opts.origin?.({ sessionId: o.sessionId ?? '', ts: t, text }) ?? 'utente';
            const b = bucket(t);
            b.prompts++;
            if (s.origin === 'auto') b.promptsAuto++;
          }
          const u = o.type === 'assistant' ? o.message?.usage : undefined;
          if (!u || !o.message) continue;
          const model = shortModel(o.message.model || '?');
          if (model === '<synthetic>') continue;
          if (!claim(`c:${o.message.id}:${o.requestId ?? ''}`)) continue;
          const cw = u.cache_creation_input_tokens || 0;
          const cw1h = Math.min(cw, u.cache_creation?.ephemeral_1h_input_tokens || 0);
          const tok = { input: u.input_tokens || 0, cw5: cw - cw1h, cw1h, cr: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 };
          const w = rawW(tok) * modelWeight(model);
          const b = bucket(t);
          b.calls++; b.input += tok.input; b.cw5 += tok.cw5; b.cw1h += tok.cw1h; b.cr += tok.cr; b.out += tok.out; b.w += w;
          if (s.origin === 'auto') { b.callsAuto++; b.wAuto += w; }
          const m = (b.models[model] ??= { calls: 0, w: 0 });
          m.calls++; m.w += w;
        }
        rest = data.subarray(start);
      }
    } finally {
      await fh.close();
    }
    // Tempo attivo: pause fino a 5 minuti tra eventi della sessione, contate nel giorno dell'evento dopo.
    times.sort((a, b) => a - b);
    let prev = s.lastT;
    for (const t of times) {
      const g = t - prev;
      if (prev && g > 0 && g <= IDLE_GAP_MS) bucket(t).activeMs += g;
      if (t > prev) prev = t;
    }
    s.lastT = prev;
    // Con righe rimandate la dimensione resta da rileggere: al giro dopo il file non risulta invariato.
    s.size = held ? -1 : size;
    this.dirty = true;
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.opts.cacheFile), { recursive: true });
      const tmp = `${this.opts.cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, files: this.files } satisfies Cache));
      fs.renameSync(tmp, this.opts.cacheFile);
      this.dirty = false;
    } catch (err) {
      console.error('Cache dei consumi non salvata:', err);
    }
  }
}
