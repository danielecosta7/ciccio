import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, stableJson, updateConfig, type CommandEntry, type CompanionConfig, type ServerEntry } from './config.js';
import { LocalServer, type BuiltinOptions } from './local.js';
import { addRootToConfig, pcAsk, pcConfirm, type ConfirmAnswer, type ConfirmRequest } from './access.js';
import type { RootSpec, TransferClient } from './file.js';
import { serverSlug } from '../../shared/companion.js';
import { dim, log, red, yellow } from './log.js';

// I server MCP locali della config, tenuti allineati al file: quando config.json cambia (a mano, o perché
// il companion stesso vi ha scritto una proposta accettata sul PC) si avviano i server nuovi, si fermano
// quelli tolti e si riavviano solo quelli cambiati, senza «Ricollega». Una config non valida non tocca niente.

const RELOAD_DEBOUNCE_MS = 400;
/** Quanto si aspetta che un server appena aggiunto parta, per dirlo all'agente che l'ha proposto. */
const ADD_WAIT_MS = 25_000;

export interface LocalServersOptions {
  /** Finestre sul PC (chiedi_accesso, proposte). false nelle prove senza desktop. */
  interactive?: boolean;
  /** Scambio di file con Ciccio (scarica_da_ciccio, carica_su_ciccio). */
  transfer?: TransferClient;
  /** Prove: la finestra delle proposte al posto di quella del PC. */
  confirm?: (req: ConfirmRequest, signal: AbortSignal) => Promise<ConfirmAnswer>;
}

/** Identità e versione del file: un rename cambia l'inode, una scrittura la data o la dimensione. */
function configStamp(file: string): string {
  try { const s = fs.statSync(file); return `${s.ino}:${s.mtimeMs}:${s.size}`; } catch { return ''; }
}

export class LocalServers {
  readonly map = new Map<string, LocalServer>();
  /** Voce della config (JSON ordinato) con cui è partito ogni server: si riavvia solo se cambia. */
  private snapshot = new Map<string, string>();
  /** Nome com'è nella config, per scriverci. */
  private keys = new Map<string, string>();
  private starting = new Map<string, Promise<void>>();
  /** Cartelle consentite «questa volta»: condivise tra i server «file» e «comandi», sopravvivono ai riavvii. */
  private once: Exclude<RootSpec, string>[] = [];
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** config.json com'era all'ultima lettura (configStamp) e il controllo in attesa. */
  private stamp = '';
  private stampTimer: ReturnType<typeof setTimeout> | undefined;
  private lastProblem = '';
  /** Un server nuovo è nella mappa (prima di partire). */
  onAdded?: (s: LocalServer) => void;
  /** Server aggiunti o tolti. */
  onChanged?: () => void;
  /** Config riletta e valida (anche se i server non cambiano): per le altre voci, come i ponti SSH. */
  onReloaded?: () => void;

  constructor(private configPath: string, private cfg: CompanionConfig, private opts: LocalServersOptions = {}) {
    this.apply(cfg, false);
  }

  /** Avvia tutti i server (all'accensione). */
  startAll(): Promise<void[]> {
    return Promise.all([...this.map.keys()].map((n) => this.startOne(n)));
  }

  private startOne(name: string): Promise<void> {
    const p = this.map.get(name)!.start();
    this.starting.set(name, p);
    return p;
  }

  /** Cartelle dei server «file» della config, com'è adesso, più quelle «questa volta». */
  private fileRoots(): RootSpec[] {
    const now = Date.now();
    const specs = [...this.map.values()].flatMap((s) => ('builtin' in s.entry && s.entry.builtin === 'file' ? s.entry.roots : []));
    return [...specs, ...this.once.filter((s) => s.finoA! > now)];
  }

  private builtinOptions(key: string, entry: ServerEntry): BuiltinOptions {
    if (!('builtin' in entry)) return {};
    const interactive = this.opts.interactive !== false || !!this.opts.confirm;
    if (entry.builtin === 'file') {
      return { file: {
        // chiedi_accesso mostra la richiesta su questo PC e «Consenti sempre» scrive nella config.
        ...(this.opts.interactive !== false ? { ask: pcAsk(), persist: (root: { path: string; solaLettura?: true }) => { addRootToConfig(this.configPath, key, root); this.resync(key); } } : {}),
        once: this.once,
        transfer: this.opts.transfer,
      } };
    }
    return { comandi: {
      roots: () => this.fileRoots(),
      serverNames: () => Object.keys(this.cfg.mcpServers),
      ...(interactive ? {
        confirm: this.opts.confirm ?? pcConfirm(),
        saveCommand: (name: string, c: CommandEntry) => this.saveCommand(key, name, c),
        addServer: (name: string, e: Record<string, unknown>) => this.addServer(name, e),
      } : {}),
    } };
  }

  /** Allinea i server alla config: nuovi avviati, tolti fermati, cambiati riavviati. */
  private apply(next: CompanionConfig, start: boolean): { added: string[]; removed: string[]; restarted: string[] } {
    const wanted = new Map<string, { key: string; entry: ServerEntry; json: string }>();
    for (const [key, entry] of Object.entries(next.mcpServers)) {
      if (entry.disabled) continue;
      const name = serverSlug(key);
      if (!name || wanted.has(name)) { log(red(`server "${key}" ignorato: nome non valido o doppio`)); continue; }
      wanted.set(name, { key, entry, json: stableJson(entry) });
    }
    const added: string[] = [];
    const removed: string[] = [];
    const restarted: string[] = [];
    for (const [name, s] of [...this.map]) {
      const w = wanted.get(name);
      if (w && w.json === this.snapshot.get(name)) continue;
      void s.stop();
      this.map.delete(name);
      this.snapshot.delete(name);
      this.starting.delete(name);
      (w ? restarted : removed).push(name);
    }
    this.cfg = next;
    for (const [name, w] of wanted) {
      if (this.map.has(name)) continue;
      const s = new LocalServer(name, w.entry, this.builtinOptions(w.key, w.entry));
      this.map.set(name, s);
      this.snapshot.set(name, w.json);
      this.keys.set(name, w.key);
      if (!restarted.includes(name)) added.push(name);
      this.onAdded?.(s);
      if (start) void this.startOne(name);
    }
    if (added.length || removed.length || restarted.length) this.onChanged?.();
    return { added, removed, restarted };
  }

  /** Rilegge config.json; se non è valida resta tutto com'è (lo si scrive una volta nel registro). */
  reload(): boolean {
    this.stamp = configStamp(this.configPath);
    let next: CompanionConfig;
    try { next = loadConfig(this.configPath); } catch (e) {
      const msg = (e as Error).message.split('\n').slice(0, 4).join(' · ');
      if (msg !== this.lastProblem) log(yellow(`config cambiata ma non valida, resto con quella di prima: ${msg}`));
      this.lastProblem = msg;
      return false;
    }
    this.lastProblem = '';
    if (next.token !== this.cfg.token || next.server !== this.cfg.server) log(yellow('token o server di Ciccio cambiati nella config: valgono dopo «Ricollega» (o al prossimo avvio)'));
    const r = this.apply(next, true);
    const parts = [r.added.length ? `aggiunti ${r.added.join(', ')}` : '', r.removed.length ? `tolti ${r.removed.join(', ')}` : '', r.restarted.length ? `riavviati ${r.restarted.join(', ')}` : ''].filter(Boolean);
    if (parts.length) log(`config ricaricata · ${parts.join(' · ')}`);
    this.onReloaded?.();
    return true;
  }

  /**
   * Il companion ha appena scritto nella config per conto del server `key` (che ha già aggiornato sé stesso):
   * la voce nuova diventa quella di riferimento, senza riavviarlo.
   */
  private resync(key: string) {
    try {
      const next = loadConfig(this.configPath);
      const name = serverSlug(key);
      const e = next.mcpServers[key];
      if (e && this.map.has(name)) this.snapshot.set(name, stableJson(e));
      this.cfg = next;
    } catch { /* la rilegge il controllo del file */ }
  }

  /** «Consenti sempre» di proponi_comando: la voce nella config del server `key`. */
  private saveCommand(key: string, name: string, c: CommandEntry) {
    updateConfig(this.configPath, (raw) => {
      const entry = raw.mcpServers?.[key];
      if (!entry) throw new Error(`nella config non c'è la voce «${key}»`);
      const list = (entry.comandi ??= {}) as Record<string, unknown>;
      if (list[name]) throw new Error(`c'è già il comando ${name}`);
      list[name] = c;
    });
    this.resync(key);
  }

  /** «Consenti sempre» di proponi_strumento: il server nella config, avviato subito; com'è andata. */
  private async addServer(name: string, entry: Record<string, unknown>) {
    updateConfig(this.configPath, (raw) => {
      const servers = (raw.mcpServers ??= {});
      if (Object.keys(servers).some((k) => serverSlug(k) === name)) throw new Error(`c'è già un server «${name}»`);
      servers[name] = entry;
    });
    this.reload();
    const s = this.map.get(name);
    if (!s) return { stato: 'offline', strumenti: 0, errore: 'non avviato (config del PC?)' };
    await Promise.race([this.starting.get(name), new Promise((r) => setTimeout(r, ADD_WAIT_MS))]);
    return { stato: s.state.status, strumenti: s.state.tools.length, ...(s.state.error ? { errore: s.state.error } : {}) };
  }

  /** Ricarica da sola quando config.json cambia sul disco. */
  watch() {
    const dir = path.dirname(this.configPath);
    const file = path.basename(this.configPath).toLowerCase();
    try {
      const later = () => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.reload(), RELOAD_DEBOUNCE_MS);
      };
      this.stamp = configStamp(this.configPath);
      this.watcher = fs.watch(dir, (_ev, name) => {
        if (!name || String(name).toLowerCase() === file) { later(); return; }
        // Una sostituzione atomica fatta da fuori (config.json.tmp + rename) con Bun su macOS arriva solo
        // col nome del file temporaneo: per gli altri nomi si guarda se config.json è cambiato davvero.
        // Al più un controllo ogni RELOAD_DEBOUNCE_MS, perché nella cartella si scrivono anche registro e stato.
        if (this.stampTimer) return;
        this.stampTimer = setTimeout(() => {
          this.stampTimer = undefined;
          if (configStamp(this.configPath) !== this.stamp) later();
        }, RELOAD_DEBOUNCE_MS);
      });
      this.watcher.on('error', (e) => log(yellow(`controllo della config interrotto: ${e.message}`)));
      this.watcher.unref?.();
      log(dim(`config: ${this.configPath} (si ricarica da sola quando cambia)`));
    } catch (e) { log(yellow(`la config non si ricarica da sola (${(e as Error).message}): dopo una modifica serve «Ricollega»`)); }
  }

  async stopAll() {
    this.watcher?.close();
    clearTimeout(this.timer);
    clearTimeout(this.stampTimer);
    await Promise.all([...this.map.values()].map((s) => s.stop()));
  }
}
