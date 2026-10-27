import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

// git lanciato dal server di Ciccio, fuori da ogni sandbox, su repo che gli agenti modificano: niente hook,
// niente fsmonitor (con .git/config o .git/hooks un agente farebbe girare un programma fuori dalla sandbox)
// e niente /etc/gitconfig. .git/config resta protetto a monte (sandbox, confine.ts, toolSandbox.ts): questo è
// il secondo strato. Tutti i git del server passano da qui.

const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never'];

export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // Su Windows (prove sul PC) la configurazione di sistema di Git for Windows serve (core.autocrlf, certificati):
  // senza, ogni file risulterebbe modificato.
  return { ...process.env, ...extra, ...(process.platform === 'win32' ? {} : { GIT_CONFIG_NOSYSTEM: '1' }) };
}

type SyncOptions = { encoding?: BufferEncoding; timeout?: number; maxBuffer?: number; stdio?: ('ignore' | 'pipe')[]; env?: NodeJS.ProcessEnv; cwd?: string };

/** git sincrono, output come testo (non rifilato). */
export function gitSync(args: string[], opts: SyncOptions = {}): string {
  return execFileSync('git', [...SAFE, ...args], { encoding: 'utf8', ...opts, env: gitEnv(opts.env) }) as string;
}

const run = promisify(execFile);

/** git asincrono: stdout e stderr come testo. */
export function gitAsync(args: string[], opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
  return run('git', [...SAFE, ...args], { ...opts, env: gitEnv(opts.env), encoding: 'utf8' });
}
