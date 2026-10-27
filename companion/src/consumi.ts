import os from 'node:os';
import path from 'node:path';
import { configDir } from './config.js';
import { log, yellow } from './log.js';
import { TranscriptScanner } from '../../shared/node/transcripts.js';
import { USAGE_METHOD, type UsageParams } from '../../shared/consumi.js';

// Consumi di Claude Code su questo PC, per il confronto con Ciccio (Impostazioni › Consumi): il companion legge i
// transcript locali (~/.claude/projects) e manda a Ciccio solo i totali per giorno e progetto. Nessun testo delle
// conversazioni lascia il PC. La prima lettura è completa, poi solo le righe nuove (cache in ~/.ciccio-companion).

const EVERY_MS = 60 * 60_000;

const enc = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');

/** Cartella dei transcript → progetto: senza la cartella utente davanti e con i worktree insieme al loro repo. */
function projectOf(dir: string): string {
  const home = enc(os.homedir());
  const name = dir.startsWith(home) ? dir.slice(home.length).replace(/^-+/, '') : dir;
  return name.replace(/--claude-worktrees-.*$/, '') || 'cartella utente';
}

export class UsageReporter {
  private scanner = new TranscriptScanner({
    root: path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects'),
    cacheFile: path.join(configDir(), 'consumi-cache.json'),
    project: projectOf,
  });
  private timer: ReturnType<typeof setInterval> | undefined;
  private problem = '';

  constructor(private send: (msg: unknown) => void) {}

  /** Collegato a Ciccio: manda subito i totali, poi ogni ora. */
  start() {
    void this.report();
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.report(), EVERY_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  private async report() {
    try {
      await this.scanner.refresh();
      const params: UsageParams = { buckets: this.scanner.buckets(), at: Date.now() };
      this.send({ jsonrpc: '2.0', method: USAGE_METHOD, params });
      this.problem = '';
    } catch (err) {
      const line = `consumi di Claude Code non letti: ${(err as Error).message}`;
      if (line !== this.problem) log(yellow(`○ ${line}`));
      this.problem = line;
    }
  }
}
