import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { HookCallbackMatcher, SandboxSettings, Settings } from '@anthropic-ai/claude-agent-sdk';
import { config, OWNER } from './config.js';
import { gitSync } from './git.js';
import type { Verdict } from './policy.js';

// Ogni agente lavora solo sul suo repo: non legge né scrive gli altri progetti, i dati di Ciccio o le
// credenziali, e non tocca altri repo su GitHub. Tre strati, validi in ogni livello di autorizzazione:
// - la sandbox di Claude Code (bubblewrap) sui comandi Bash: il sistema operativo nasconde gli altri
//   progetti e lascia scrivere solo nella cartella della chat, qualunque cosa faccia il comando;
// - i controlli qui sotto sugli strumenti che girano fuori dalla sandbox (Read, Edit, Write, Glob, Grep), sulla
//   rete e sui comandi git/gh che parlano con GitHub, dove il token di gh vale per tutti i repo dell'utente. Girano
//   in un hook PreToolUse (prima di ogni regola di permesso) e di nuovo in canUseTool;
// - le impostazioni di blocco della sessione (sessionLockdown): hook, regole di permesso, server MCP e agenti scritti
//   nei file del repo (.claude/, .mcp.json) non valgono, perché girerebbero nel processo di Claude Code, fuori dalla
//   sandbox, o deciderebbero prima di Ciccio.

const P = path.posix;
const HOME = os.homedir();
/** Cartella di Ciccio (codice e build): il servizio parte da lì. */
const APP_DIR = process.cwd();
const SSH_HOSTS_FILE = '/etc/ciccio/ssh-hosts';

/** Dove lavora una sessione: il progetto (id e repo) e la cartella della chat (il repo o il suo worktree). */
export interface Scope { project: string; repo: string; dir: string; slug: string | null }

// ---------------------------------------------------------------- cartelle del progetto

/**
 * Nome di cartella per un progetto, diverso per ogni id: lettere, cifre e trattini restano, il resto diventa
 * _<codice>_ (così «a-b», «a_b» e «a.b» non finiscono nella stessa cartella).
 */
export function projectKey(project: string): string {
  return project.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
}

/**
 * Cartelle di un progetto tenute da Ciccio (~/.ciccio/progetti/<progetto>): la memoria di Claude Code, le cache dei
 * pacchetti e gli host SSH già visti. Sono solo sue: un progetto non avvelena le cache o i known_hosts di un altro.
 */
export function projectDirs(project: string) {
  const root = P.join(config.dataDir, 'progetti', projectKey(project));
  return { root, memory: P.join(root, 'memoria'), cache: P.join(root, 'cache'), ssh: P.join(root, 'ssh'), knownHosts: P.join(root, 'ssh', 'known_hosts') };
}

/** Cartella della memoria di Claude Code per il progetto (autoMemoryDirectory delle sessioni). */
export function memoryDir(project: string): string {
  return projectDirs(project).memory;
}

/** Dove Claude Code teneva la memoria prima (~/.claude/projects/<percorso con i trattini>/memory). */
function legacyMemoryDir(repo: string): string {
  return P.join(HOME, '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
}

/**
 * Crea le cartelle del progetto e, la prima volta, copia la memoria dalla cartella di prima. Se due progetti
 * finivano nella stessa cartella vecchia (a-b e a_b) non si copia niente: la memoria era mischiata, la divide l'utente.
 */
export function prepareProjectDirs(project: string, repo: string, allRepos: string[]): void {
  const d = projectDirs(project);
  if (!fs.existsSync(d.memory)) {
    const old = legacyMemoryDir(repo);
    const shared = allRepos.some((r) => r !== repo && legacyMemoryDir(r) === old);
    if (shared && fs.existsSync(old)) console.warn(`Memoria di ${project} non copiata: ${old} era in comune con un altro progetto.`);
    try {
      // Solo file e cartelle: un collegamento nella memoria di prima porterebbe fuori.
      if (!shared && fs.existsSync(old)) fs.cpSync(old, d.memory, { recursive: true, filter: (src) => !fs.lstatSync(src).isSymbolicLink() });
    } catch (e) { console.warn(`Memoria di ${project} non copiata da ${old}:`, (e as Error).message); }
  }
  try { for (const p of [d.memory, d.cache, d.ssh]) fs.mkdirSync(p, { recursive: true, mode: 0o700 }); } catch (e) { console.warn(`Cartelle di ${project} non create:`, (e as Error).message); }
}

/**
 * Variabili d'ambiente che mandano cache dei pacchetti e host SSH nelle cartelle del progetto (per i comandi della
 * sandbox e per gli strumenti su misura). Le cache dell'utente (~/.npm, ~/.cache/…) restano in sola lettura.
 */
export function projectEnv(project: string): Record<string, string> {
  const { cache, knownHosts } = projectDirs(project);
  const pnpmStore = P.join(cache, 'pnpm-store');
  const pnpmCache = P.join(cache, 'pnpm');
  return {
    npm_config_cache: P.join(cache, 'npm'),
    npm_config_store_dir: pnpmStore, pnpm_config_store_dir: pnpmStore,
    npm_config_cache_dir: pnpmCache, pnpm_config_cache_dir: pnpmCache,
    COREPACK_HOME: P.join(cache, 'corepack'),
    UV_CACHE_DIR: P.join(cache, 'uv'),
    PIP_CACHE_DIR: P.join(cache, 'pip'),
    // Letto da ~/.ssh/config dentro la sandbox (UserKnownHostsFile ${CICCIO_KNOWN_HOSTS}, vedi install.sh).
    CICCIO_KNOWN_HOSTS: knownHosts,
  };
}

// ---------------------------------------------------------------- zone vietate

/** Zone che nessun agente legge o scrive, a parte le eccezioni del suo progetto. */
function forbiddenRoots(): string[] {
  return [
    config.projectsDir, config.dataDir, APP_DIR, P.join(HOME, 'ciccio'),
    P.join(HOME, '.config', 'ciccio.env'), P.join(HOME, '.claude.json'),
  ];
}

/**
 * Dati e credenziali dell'utente fuori dai progetti: ~/.claude (cronologia, piani, todo, impostazioni, credenziali e
 * file di tutti i progetti), chiavi e host SSH, token di npm, git, Docker, PyPI e 1Password.
 */
function secretRoots(): string[] {
  return [
    P.join(HOME, '.claude'), P.join(HOME, '.ssh'),
    P.join(HOME, '.npmrc'), P.join(HOME, '.yarnrc'), P.join(HOME, '.yarnrc.yml'), P.join(HOME, '.git-credentials'), P.join(HOME, '.config', 'git', 'credentials'),
    P.join(HOME, '.netrc'), P.join(HOME, '.pypirc'), P.join(HOME, '.docker', 'config.json'), P.join(HOME, '.config', 'op'),
  ];
}

/** Token di GitHub: i comandi della sandbox lo vedono (gh e git push ne hanno bisogno), Read, Glob e Grep no. */
const GH_CONFIG = P.join(HOME, '.config', 'gh');

/**
 * Dentro le zone segrete, quello che la sandbox dei comandi deve poter leggere: le skill e i plugin (con i loro
 * script), le istantanee della shell che Claude Code fa girare prima di ogni comando e i file d'ambiente della
 * sessione; di ~/.ssh solo config (porta ssh nel proxy della sandbox) e known_hosts dell'utente (sola lettura).
 */
const SANDBOX_READ_BACK = [
  P.join(HOME, '.claude', 'skills'), P.join(HOME, '.claude', 'plugins'), P.join(HOME, '.claude', 'shell-snapshots'), P.join(HOME, '.claude', 'session-env'),
  P.join(HOME, '.ssh', 'config'), P.join(HOME, '.ssh', 'known_hosts'),
];

/** Le stesse eccezioni per Read, Glob e Grep: le skill e i plugin (Claude legge i file accanto a SKILL.md). */
const TOOL_READ_BACK = [P.join(HOME, '.claude', 'skills'), P.join(HOME, '.claude', 'plugins')];

/**
 * Socket Unix di sistema da nascondere alla sandbox. Su Linux la sandbox o blocca tutti i socket Unix (e allora
 * niente agent SSH) o li lascia tutti: si lasciano, e si tolgono di vista quelli che danno poteri fuori dalla
 * sandbox (systemd e dbus dell'utente: systemd-run eseguirebbe comandi senza sandbox; dbus di sistema, docker,
 * tailscale, snapd, lxd, fail2ban, udev).
 */
const SYSTEM_SOCKETS = [
  '/run/user', '/run/dbus', '/var/run/dbus', '/run/systemd/private', '/run/systemd/userdb', '/run/systemd/io.systemd.sysext',
  '/run/docker.sock', '/var/run/docker.sock', '/run/tailscale', '/var/run/tailscale', '/run/snapd.socket', '/run/snapd-snap.socket',
  '/run/lxd-installer.socket', '/run/fail2ban', '/run/udev',
  // Non /tmp/claude-http-*.sock né /tmp/srt-mux-*.sock: sono il ponte tra la sandbox e il suo proxy di rete.
];

/**
 * Zone da nascondere agli strumenti su misura (toolSandbox.ts): quelle della sandbox di Bash, senza eccezioni
 * (girano programmi di terzi, come i server MCP da npx), token di GitHub compreso.
 */
export function hiddenFromSandbox(): string[] {
  return [...forbiddenRoots(), ...secretRoots(), GH_CONFIG, ...SYSTEM_SOCKETS];
}

/**
 * Percorsi della cartella di una chat che restano in sola lettura anche nelle sandbox: git, impostazioni e hook di
 * Claude Code, server MCP, sotto-moduli e, dalla cartella principale, i worktree delle altre chat.
 */
export function readOnlyInDir(dir: string): string[] {
  return ['.git', '.claude', '.mcp.json', '.gitmodules', P.join('.ciccio', 'worktrees')].map((p) => P.join(dir, p));
}

/** Sandbox dei comandi Bash di un agente: legge e scrive la cartella della chat, il resto dei progetti non lo vede. */
export function agentSandbox(scope: Scope, sshSock: string): SandboxSettings {
  const own = projectDirs(scope.project);
  return {
    enabled: true,
    // Senza bubblewrap la sessione non parte, invece di girare scoperta.
    failIfUnavailable: true,
    // Ogni comando passa comunque dai controlli di Ciccio (canUseTool) e non può uscire dalla sandbox.
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: [...forbiddenRoots(), ...secretRoots(), ...SYSTEM_SOCKETS],
      allowRead: [scope.dir, own.root, sshSock, ...SANDBOX_READ_BACK],
      // Oltre alla cartella della chat (e alla cartella temporanea della sessione): cache e host SSH del progetto.
      allowWrite: [own.cache, own.ssh],
      // Dentro la cartella della chat: git (gli oggetti e i branch sì, hook e config no: li tiene già Claude Code),
      // .claude, .mcp.json, .gitmodules e i worktree delle altre chat.
      denyWrite: readOnlyInDir(scope.dir).filter((p) => !p.endsWith('/.git')),
    },
    // I domini li filtra già il firewall in uscita (tinyproxy); gli indirizzi interni li nega confineNetwork.
    // Socket Unix: su Linux allowUnixSockets non basta (il filtro seccomp li blocca tutti), quindi tutti aperti e
    // quelli pericolosi nascosti sopra; degli agent SSH di Ciccio si vede solo quello della chat (~/.ciccio è
    // nascosto, il socket della chat riaperto).
    network: { allowAllUnixSockets: true },
  };
}

/**
 * Impostazioni di blocco per le sessioni degli agenti (managedSettings: valgono sopra quelle dei file). I file del
 * repo (.claude/settings*.json, .mcp.json, .claude/agents) potrebbero venire da un fork o essere stati scritti da un
 * agente: con queste
 * - nessun hook dai file di impostazioni (gli hook di Ciccio, passati all'SDK, girano lo stesso);
 * - nessuna regola di permesso dai file: decide solo Ciccio (canUseTool), non un «allow» in .claude/settings.json;
 * - nessun server MCP da .mcp.json o dalle impostazioni (girerebbero fuori dalla sandbox): solo quelli di Ciccio
 *   e i connettori di claude.ai;
 * - nessun agente definito in .claude/agents o ~/.claude/agents (frontmatter con permissionMode, hook, server MCP).
 * Restano CLAUDE.md, le skill e i comandi con «/» (il loro allowed-tools non vale).
 */
export function sessionLockdown(): Settings {
  return {
    allowManagedHooksOnly: true,
    allowManagedPermissionRulesOnly: true,
    strictPluginOnlyCustomization: ['hooks', 'mcp', 'agents'],
  };
}

/**
 * NO_PROXY per le sessioni: i server SSH dell'elenco di Ciccio si raggiungono diretti (il firewall
 * lascia passare solo la porta SSH verso di loro), non attraverso tinyproxy che apre solo 80 e 443.
 */
export function noProxyWithSshHosts(current: string | undefined): string {
  let hosts: string[] = [];
  try {
    hosts = fs.readFileSync(SSH_HOSTS_FILE, 'utf8').split('\n')
      .map((l) => l.replace(/#.*/, '').trim().replace(/:\d+$/, '')).filter(Boolean);
  } catch { /* nessun elenco */ }
  return [...new Set([...(current ?? '').split(',').map((s) => s.trim()).filter(Boolean), ...hosts])].join(',');
}

/** owner/nome del repo GitHub del progetto (remote origin), in minuscolo; null se non è su GitHub. */
export function repoSlug(repo: string): string | null {
  try {
    const url = gitSync(['-C', repo, 'remote', 'get-url', 'origin'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return slugOf(url);
  } catch {
    return null;
  }
}

function slugOf(url: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

// ---------------------------------------------------------------- percorsi degli strumenti

const READ_TOOLS: Record<string, string[]> = {
  Read: ['file_path'], Glob: ['path'], Grep: ['path'], LS: ['path'], NotebookRead: ['notebook_path'],
};
const WRITE_TOOLS: Record<string, string[]> = {
  Edit: ['file_path'], MultiEdit: ['file_path'], Write: ['file_path'], NotebookEdit: ['notebook_path'],
};

function inside(p: string, dir: string): boolean {
  const rel = P.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel));
}

/** Percorso assoluto, con ~ espanso e i link simbolici risolti fin dove il percorso esiste. */
function resolvePath(raw: string, base: string): string {
  const expanded = raw === '~' ? HOME : raw.startsWith('~/') ? P.join(HOME, raw.slice(2)) : raw;
  let p = P.resolve(base, expanded);
  // Un link nel repo che punta a un altro progetto conta per dove arriva.
  const rest: string[] = [];
  for (let cur = p; ; cur = P.dirname(cur)) {
    try {
      p = P.join(fs.realpathSync(cur), ...rest.reverse());
      break;
    } catch {
      if (cur === '/') break;
      rest.push(P.basename(cur));
    }
  }
  return p;
}

/**
 * File che decidono cosa può fare Claude Code (impostazioni, hook, agenti, skill, comandi, server MCP) o git, a
 * qualsiasi profondità (anche dentro un worktree o un sotto-progetto), più i worktree delle altre chat.
 * `rel` è relativo alla cartella della chat, con «/».
 */
export function protectedInRepo(rel: string): boolean {
  return /(^|\/)\.(git|claude)(\/|$)/i.test(rel) || /(^|\/)\.(mcp\.json|gitmodules)$/i.test(rel) || /^\.ciccio\/worktrees(\/|$)/i.test(rel);
}

function checkPath(toolName: string, raw: string, scope: Scope, write: boolean): Verdict | null {
  const p = resolvePath(raw, scope.dir);
  const memory = memoryDir(scope.project);
  if (write) {
    if (inside(p, memory)) return null;
    if (!inside(p, scope.dir)) return { action: 'deny', reason: `Scrivi solo dentro la cartella di questa chat (${scope.dir}): ${raw} è fuori.` };
    const rel = P.relative(scope.dir, p);
    if (/^\.ciccio\/worktrees(\/|$)/i.test(rel)) return { action: 'deny', reason: `${raw} è nella cartella di lavoro di un'altra chat del progetto: non si tocca da qui.` };
    if (protectedInRepo(rel)) return { action: 'deny', reason: `${raw} decide permessi, hook, server MCP o git del progetto: lo modifica solo ${OWNER}.` };
    return null;
  }
  if ([scope.repo, scope.dir, memory, ...TOOL_READ_BACK].some((d) => inside(p, d))) return null;
  if (inside(p, GH_CONFIG) || (toolName !== 'Read' && inside(GH_CONFIG, p))) return { action: 'deny', reason: 'Il token di GitHub non si legge.' };
  if (secretRoots().some((r) => inside(p, r) || (toolName !== 'Read' && inside(r, p)))) {
    return { action: 'deny', reason: `${raw} contiene credenziali o dati di ${OWNER} fuori dal progetto: non si legge.` };
  }
  const forbidden = forbiddenRoots().find((r) => inside(p, r) || (toolName !== 'Read' && inside(r, p)));
  return forbidden
    ? { action: 'deny', reason: `Lavori solo sul tuo progetto: ${raw} è di un altro progetto o di Ciccio.` }
    : null;
}

// ---------------------------------------------------------------- comandi verso GitHub

// "git", le sue opzioni globali (-C dir, -c chiave=valore, --git-dir=…, --no-pager…) e poi il sottocomando:
// così un messaggio di commit che contiene «clone» non conta.
const GIT = String.raw`\bgit((?:\s+(?:-[Cc]\s*\S+|--[\w-]+(?:=\S+)?|-[a-zA-Z]))*)\s+`;
const GIT_KEYS = /(^|[\s'"])(remote\.|url\.|credential|core\.sshcommand|core\.hookspath|core\.gitproxy|core\.fsmonitor|include\.|includeif\.)/i;

const BLOCKED_COMMANDS: { test: RegExp; reason: string }[] = [
  { test: new RegExp(`${GIT}(clone|submodule\\s+add)\\b`), reason: 'Niente clone di altri repo: lavori solo sul repo del progetto.' },
  { test: new RegExp(`${GIT}remote\\s+(add|set-url|rename|remove|rm)\\b`), reason: 'I remote del repo non si cambiano: lavori solo sul repo del progetto.' },
  // Il token: gh auth token/status -t, git credential, il file di gh (anche spostato con GH_CONFIG_DIR) e le variabili.
  {
    test: new RegExp(String.raw`\bgh\s+auth\s+(token|login|logout|refresh|switch|setup-git|git-credential)\b|\bgh\s+auth\s+status\b[^|;&\n]*\s-[a-zA-Z]*t|--show-token\b|${GIT}credential\b|\bgit-credential\b|\.config\/gh\b|gh\/hosts\.yml|\bGH_CONFIG_DIR\b|\b(GH|GITHUB)_TOKEN=`),
    reason: 'Il token di GitHub non si legge e non si cambia.',
  },
  { test: /\bgh\s+search\b|\bgh\s+repo\s+(?!view\b)\w+/, reason: 'gh lavora solo sul repo del progetto (gh repo view al massimo).' },
  { test: /\bgh\s+api\b[^|;&\n]*\bgraphql\b|api\.github\.com\/graphql|\buser\/repos\b|\borgs\/[\w.-]+\/repos\b/, reason: 'API di GitHub solo sul repo del progetto: niente graphql o elenchi di repo.' },
];

/** Repo GitHub nominati nel comando (URL, -R/--repo, repos/owner/nome di gh api), in minuscolo. */
function reposIn(cmd: string): string[] {
  const out: string[] = [];
  // github.com/owner/nome e git@github.com:owner/nome (non api.github.com, che ha i suoi repos/…).
  for (const m of cmd.matchAll(/(?<![\w.-])(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+)/gi)) out.push(`${m[1]}/${m[2]}`);
  for (const m of cmd.matchAll(/(?:^|[\s'"/])repos\/([\w.-]+|\{owner\})\/([\w.-]+|\{repo\})/g)) out.push(`${m[1]}/${m[2]}`);
  for (const m of cmd.matchAll(/\bgh\b[^|;&\n]*?\s(?:-R\s*|--repo[=\s]+)['"]?([\w.\/-]+)/g)) out.push(m[1]);
  for (const m of cmd.matchAll(/\bgh\s+repo\s+view\s+['"]?([\w.-]+\/[\w.-]+)/g)) out.push(m[1]);
  return out.map((s) => s.replace(/^github\.com\//i, '').replace(/\.git$/i, '').toLowerCase());
}

/** git -c remote.…/url.…/credential… o git config sulle stesse chiavi: cambierebbero dove va il push. */
function touchesGitConfig(cmd: string): boolean {
  for (const m of cmd.matchAll(new RegExp(`${GIT}(\\S+)([^|;&\\n]*)`, 'g'))) {
    const [, globals = '', sub, args = ''] = m;
    for (const c of globals.matchAll(/-c\s*(\S+)/g)) if (GIT_KEYS.test(` ${c[1]}`)) return true;
    if (sub === 'config' && GIT_KEYS.test(args)) return true;
  }
  return false;
}

function checkCommand(cmd: string, slug: string | null): Verdict | null {
  for (const r of BLOCKED_COMMANDS) if (r.test.test(cmd)) return { action: 'deny', reason: r.reason };
  if (touchesGitConfig(cmd)) return { action: 'deny', reason: `Configurazione git di remote, credenziali o hook: la cambia solo ${OWNER}.` };
  const other = reposIn(cmd).find((s) => s !== '{owner}/{repo}' && s !== slug);
  if (other) return { action: 'deny', reason: `Lavori solo sul repo ${slug ?? 'del progetto'}: ${other} è un altro repo.` };
  return null;
}

/**
 * Controllo di confinamento, prima del livello di autorizzazione: nega e basta, in ogni livello.
 * null = niente da obiettare (poi decide il livello).
 */
export function confine(toolName: string, input: Record<string, unknown>, scope: Scope): Verdict | null {
  if (toolName === 'Bash' || toolName === 'Monitor') {
    return typeof input.command === 'string' ? checkCommand(input.command, scope.slug) : null;
  }
  const write = WRITE_TOOLS[toolName];
  const read = READ_TOOLS[toolName];
  for (const key of write ?? read ?? []) {
    const v = input[key];
    if (typeof v === 'string' && v) {
      const verdict = checkPath(toolName, v, scope, !!write);
      if (verdict) return verdict;
    }
  }
  return null;
}

// ---------------------------------------------------------------- rete

/**
 * Indirizzi che un agente non raggiunge: questa macchina (l'API di Ciccio su 127.0.0.1:8787, il proxy, la voce),
 * le reti private e link-local, la tailnet di Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) e gli indirizzi speciali.
 */
const PRIVATE_NETS = (() => {
  const b = new net.BlockList();
  for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) b.addSubnet(a, n, 'ipv4');
  for (const [a, n] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]] as const) b.addSubnet(a, n, 'ipv6');
  return b;
})();

/** true se l'indirizzo IP è interno (vedi sopra) o è di un'interfaccia di questa macchina (anche l'IP pubblico). */
export function privateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (!kind) return false;
  // ::ffff:127.0.0.1 e simili: conta l'IPv4 dentro.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return privateAddress(mapped[1]);
  if (PRIVATE_NETS.check(ip, kind === 4 ? 'ipv4' : 'ipv6')) return true;
  const own = Object.values(os.networkInterfaces()).flat().map((i) => i?.address.toLowerCase().replace(/%.*$/, ''));
  return own.includes(ip.toLowerCase());
}

/** Motivo per cui l'host non si raggiunge (interno, o non si risolve), o null. Un nome conta per tutti i suoi indirizzi. */
export async function privateHost(raw: string): Promise<string | null> {
  const host = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return 'host mancante';
  if (host === 'localhost' || host.endsWith('.localhost')) return `${raw} è questa macchina`;
  if (net.isIP(host)) return privateAddress(host) ? `${raw} è un indirizzo interno (questa macchina, rete privata o tailnet)` : null;
  let addrs: string[];
  try {
    addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return `${raw} non si risolve`;
  }
  const bad = addrs.find(privateAddress);
  return bad ? `${raw} porta a un indirizzo interno (${bad})` : null;
}

/**
 * Rete: i comandi della sandbox (SandboxNetworkAccess, { host, port }) e WebFetch non vanno verso indirizzi interni,
 * in ogni livello. null = niente da obiettare.
 */
export async function confineNetwork(toolName: string, input: Record<string, unknown>): Promise<Verdict | null> {
  let host: string | null = null;
  if (toolName === 'SandboxNetworkAccess') host = typeof input.host === 'string' ? input.host : '';
  else if (toolName === 'WebFetch' && typeof input.url === 'string') {
    try { host = new URL(input.url).hostname; } catch { return { action: 'deny', reason: `Indirizzo non valido: ${input.url}` }; }
  }
  if (host === null) return null;
  const why = await privateHost(host);
  return why ? { action: 'deny', reason: `Rete: ${why}. Gli agenti raggiungono solo internet, non Ciccio, la tailnet o le reti interne.` } : null;
}

/** Tutto il confinamento di uno strumento: percorsi e comandi, poi la rete. */
export async function guard(toolName: string, input: Record<string, unknown>, scope: Scope): Promise<Verdict | null> {
  return confine(toolName, input, scope) ?? await confineNetwork(toolName, input);
}

/**
 * Hook PreToolUse con il confinamento, per ogni strumento (anche dei sub-agent): gli hook girano prima delle regole
 * di permesso, quindi un «allow» scritto in qualche file di impostazioni non lo salta. canUseTool rifà lo stesso
 * controllo.
 */
export function confineHook(scope: Scope, onDeny: (toolName: string, input: Record<string, unknown>, reason: string) => void): HookCallbackMatcher {
  return {
    hooks: [async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const verdict = await guard(input.tool_name, toolInput, scope);
      if (verdict?.action !== 'deny') return {};
      onDeny(input.tool_name, toolInput, verdict.reason);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } };
    }],
  };
}
