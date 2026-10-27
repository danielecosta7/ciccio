import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { hiddenFromSandbox, projectDirs, projectEnv, readOnlyInDir } from './confine.js';

// Sandbox per gli strumenti su misura dei progetti (projectTools.ts): comandi approvati e server MCP stdio.
// Girano fuori dalla sandbox di Claude Code (quella vale solo per Bash: un server MCP stdio o un comando lanciato
// dal server di Ciccio vedrebbero tutto), quindi li chiude bubblewrap con le stesse regole di agentSandbox:
// - tutto il disco in sola lettura, altri progetti, dati di Ciccio, credenziali (token di gh compreso) e socket di
//   sistema nascosti;
// - scrivibili solo il repo del progetto, le sue cache dei pacchetti e una cartella temporanea sua; dentro il repo
//   .git, .claude, .mcp.json, .gitmodules e i worktree delle altre chat restano in sola lettura (il server poi lancia
//   git fuori da ogni sandbox, e i file di Claude Code decidono hook e server MCP);
// - la rete esce comunque solo dal firewall per utente (deploy/egress-firewall.sh), sandbox o no.
// Fuori da Linux (prove sul PC) non c'è bubblewrap: si lancia senza sandbox solo con CICCIO_TOOLS_NO_SANDBOX=1.

const NO_SANDBOX = process.env.CICCIO_TOOLS_NO_SANDBOX === '1';

/** Variabili che passano al comando: niente token, niente CICCIO_*, niente chiavi dell'ambiente del server. */
const ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TZ|TERM|https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SystemRoot|ComSpec|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/;

export function toolEnv(tmp: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null && ENV_KEEP.test(k)) env[k] = v;
  return { ...env, TMPDIR: tmp, ...extra };
}

export function sandboxAvailable(): { ok: true } | { ok: false; reason: string } {
  if (process.platform === 'linux') return { ok: true };
  return NO_SANDBOX ? { ok: true } : { ok: false, reason: 'Gli strumenti su misura girano solo sul server Linux di Ciccio (bubblewrap).' };
}

/** Cartella temporanea di un'esecuzione: dentro la sandbox è l'unica scrivibile oltre al repo e alle cache del progetto. */
export function toolTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-tool-'));
}

/**
 * Programma e argomenti da lanciare: su Linux `bwrap … -- programma argomenti`, altrove (solo con
 * CICCIO_TOOLS_NO_SANDBOX=1) il programma così com'è.
 */
export function sandboxed(project: string, repo: string, tmp: string, argv: string[]): { command: string; args: string[] } {
  if (process.platform !== 'linux') return { command: argv[0], args: argv.slice(1) };
  const a = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  // Percorsi veri (/var/run è un link a /run), senza doppioni né cose già dentro una cartella nascosta.
  const real = hiddenFromSandbox().flatMap((raw) => { try { return [fs.realpathSync(raw)]; } catch { return []; } }).sort((x, y) => x.length - y.length);
  const hidden: string[] = [];
  for (const p of real) if (!hidden.some((h) => p === h || p.startsWith(`${h}/`))) hidden.push(p);
  for (const p of hidden) {
    // Una cartella diventa vuota; un file o un socket diventa /dev/null.
    a.push(...(fs.statSync(p).isDirectory() ? ['--tmpfs', p] : ['--ro-bind', '/dev/null', p]));
  }
  // Dopo i nascondigli: le cache del progetto (dentro ~/.ciccio, nascosta) e il repo (dentro la cartella dei progetti
  // nascosta) tornano visibili e scrivibili...
  const { cache } = projectDirs(project);
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  a.push('--bind', cache, cache, '--bind', repo, repo);
  // ...ma i file del repo che decidono git e Claude Code no: sopra il repo, in sola lettura (solo quelli che ci sono:
  // bwrap non crea un file vuoto al loro posto; un collegamento resta com'è).
  for (const p of readOnlyInDir(repo)) {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (st && !st.isSymbolicLink()) a.push('--ro-bind', p, p);
  }
  a.push('--bind', tmp, tmp, '--chdir', repo, '--');
  return { command: 'bwrap', args: [...a, ...argv] };
}

export interface RunResult { code: number | null; signal: string | null; out: string; err: string; timedOut: boolean; aborted: boolean; ms: number }

const CAPTURE_MAX = 256 * 1024;

/** Lancia un comando nella sandbox, senza shell, con tempo massimo; tiene la fine dell'output. */
export function runSandboxed(project: string, repo: string, argv: string[], timeoutS: number, signal: AbortSignal): Promise<RunResult> {
  const tmp = toolTmp();
  const { command, args } = sandboxed(project, repo, tmp, argv);
  const t0 = Date.now();
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, { cwd: repo, env: toolEnv(tmp, projectEnv(project)), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let out = '', err = '', timedOut = false, aborted = false;
    child.stdout?.on('data', (d: Buffer) => { out = (out + d.toString('utf8')).slice(-CAPTURE_MAX); });
    child.stderr?.on('data', (d: Buffer) => { err = (err + d.toString('utf8')).slice(-CAPTURE_MAX); });
    // Si chiude tutto il gruppo di processi (bwrap e quello che ha lanciato).
    const kill = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* già chiuso */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutS * 1000);
    const onAbort = () => { aborted = true; kill(); };
    signal.addEventListener('abort', onAbort, { once: true });
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); fs.rm(tmp, { recursive: true, force: true }, () => undefined); };
    child.once('error', (e) => { done(); reject(new Error(`il programma non parte (${e.message})`)); });
    child.once('close', (code, sig) => { done(); resolve({ code, signal: sig, out, err, timedOut, aborted, ms: Date.now() - t0 }); });
  });
}
