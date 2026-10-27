import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { claudeEnv, config, OWNER } from './config.js';
import { claudeBin } from './usage.js';
import { authStore, store } from './db.js';
import { active } from './serverStats.js';
import { companions } from './companion.js';
import { desktopApps } from './desktop.js';
import { ownerNameError, rootStep, sshHostError, type GithubLoginState, type SetupItem, type SetupReport } from '../../shared/setup.js';

// Configurazione guidata: cosa è a posto e cosa manca, controllato senza root e in fretta (ogni comando ha il suo
// tempo massimo, il risultato resta 30 secondi). Le cose che si fanno da qui (GitHub, identità git, nome,
// server SSH) hanno le loro rotte; quelle da root sono un passo di deploy/setup.sh da copiare.

const CACHE_MS = 30_000;
const SSH_HOSTS = '/etc/ciccio/ssh-hosts';
const HELPERS = ['ciccio-egress-allow', 'ciccio-apt-install', 'ciccio-ssh-allow'] as const;
const SSH_HELPER = '/usr/local/sbin/ciccio-ssh-allow';
const OWNER_KEY = 'owner_name';

interface Run { ok: boolean; code: number | null; stdout: string; stderr: string; missing: boolean }

/** Lancia un programma con un tempo massimo; non lancia mai eccezioni. */
function run(cmd: string, args: string[], timeout = 4000, env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', NO_COLOR: '1', ...env } }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
      resolve({ ok: !e, code: e ? (typeof e.code === 'number' ? e.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), missing: e?.code === 'ENOENT' });
    });
  });
}

const firstLine = (s: string) => s.trim().split('\n')[0]?.slice(0, 200) ?? '';
const readText = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** Righe utili di /etc/ciccio/ssh-hosts (niente commenti). */
function sshHosts(): string[] {
  return (readText(SSH_HOSTS) ?? '').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
}

// ── Accesso a Claude ────────────────────────────────────────────────────

/** Stato del login di Claude Code per l'utente del server, nell'ambiente delle sessioni (claude auth status). */
async function claudeAuthStatus(): Promise<{ loggedIn: boolean; authMethod: string; subscriptionType?: string } | null> {
  const r = await run(claudeBin(), ['auth', 'status'], 15_000, claudeEnv);
  try {
    const j = JSON.parse(r.stdout) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown };
    return { loggedIn: j.loggedIn === true, authMethod: String(j.authMethod ?? ''), subscriptionType: typeof j.subscriptionType === 'string' ? j.subscriptionType : undefined };
  } catch { return null; }
}

// ── Riavvio ─────────────────────────────────────────────────────────────

let restartAt = 0;

/**
 * Riavvio gentile tra poco. Il servizio ha Restart=on-failure: uscire con 0 non lo farebbe ripartire, quindi si
 * chiede a systemd di riavviarlo; lo stop arriva come SIGTERM e passa dallo spegnimento di restart.ts (i giri al
 * lavoro finiscono o riprendono dopo). Fuori da systemd (sviluppo) non si riavvia da solo.
 */
function scheduleRestart(): 'systemd' | 'manuale' {
  if (!process.env.INVOCATION_ID) return 'manuale';
  if (!restartAt) {
    restartAt = Date.now() + 2000;
    setTimeout(() => {
      const p = spawn('systemctl', ['--user', 'restart', '--no-block', 'ciccio.service'], { detached: true, stdio: 'ignore' });
      p.on('error', () => { restartAt = 0; });
      p.unref();
    }, 2000).unref();
  }
  return 'systemd';
}

// ── GitHub ──────────────────────────────────────────────────────────────

let ghLogin: GithubLoginState & { proc?: ChildProcess } = { state: 'idle' };

/** Accesso a GitHub con il codice del dispositivo: gh stampa il codice, l'utente lo scrive su github.com/login/device. */
function startGithubLogin(): GithubLoginState {
  if (ghLogin.state === 'waiting' && ghLogin.proc) return view(ghLogin);
  const proc = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https'], {
    // Nessun browser da aprire sul server: il codice e il link li mostra la pagina.
    env: { ...process.env, LC_ALL: 'C', NO_COLOR: '1', BROWSER: 'true', GH_BROWSER: 'true' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  ghLogin = { state: 'waiting', proc, url: 'https://github.com/login/device' };
  let out = '';
  const timer = setTimeout(() => { proc.kill('SIGTERM'); if (ghLogin.proc === proc) ghLogin = { state: 'error', error: 'Tempo scaduto: il codice vale 15 minuti. Riprova.' }; }, 15 * 60_000);
  const onData = (b: Buffer) => {
    out = (out + b.toString()).slice(-8000);
    const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(out)?.[1];
    if (code && ghLogin.proc === proc && !ghLogin.code) {
      ghLogin = { ...ghLogin, code };
      // «Press Enter to open github.com in your browser»: invio, così gh passa ad aspettare la conferma.
      proc.stdin?.write('\n');
    }
  };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  proc.on('error', () => { clearTimeout(timer); if (ghLogin.proc === proc) ghLogin = { state: 'error', error: 'gh non è installato sul server.' }; });
  proc.on('close', (code) => {
    clearTimeout(timer);
    if (ghLogin.proc !== proc) return;
    if (code !== 0) {
      const last = out.split('\n').map((l) => l.trim()).filter((l) => l && !/one-time code|Press Enter|Open this URL/i.test(l)).pop();
      ghLogin = { state: 'error', error: last ? `gh: ${last.slice(0, 200)}` : 'Accesso non completato.' };
      return;
    }
    void run('gh', ['auth', 'setup-git'], 10_000).then(async (r) => {
      const login = await githubLogin();
      ghLogin = r.ok ? { state: 'done', login: login ?? undefined } : { state: 'error', error: `Accesso fatto, ma gh auth setup-git non è riuscito: ${firstLine(r.stderr) || 'errore'}` };
      cached = null;
    });
  });
  return view(ghLogin);
}

function view(s: typeof ghLogin): GithubLoginState {
  const { proc: _p, ...rest } = s;
  return rest;
}

/** Account GitHub di gh, se ha fatto l'accesso (senza mai stampare il token). */
async function githubLogin(): Promise<string | null> {
  const r = await run('gh', ['auth', 'status', '--hostname', 'github.com'], 6000);
  if (!r.ok) return null;
  return /Logged in to github\.com (?:account|as) (\S+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? '';
}

async function gitIdentity() {
  const [n, e] = await Promise.all([run('git', ['config', '--global', 'user.name']), run('git', ['config', '--global', 'user.email'])]);
  return { name: n.ok ? n.stdout.trim() : '', email: e.ok ? e.stdout.trim() : '' };
}

/** Nome ed email proposti per git, dall'account GitHub (email privata: quella noreply di GitHub). */
async function gitSuggestion(): Promise<{ name: string; email: string } | null> {
  const r = await run('gh', ['api', 'user'], 8000);
  if (!r.ok) return null;
  try {
    const u = JSON.parse(r.stdout) as { id?: number; login?: string; name?: string | null; email?: string | null };
    if (!u.login) return null;
    return { name: u.name || u.login, email: u.email || `${u.id}+${u.login}@users.noreply.github.com` };
  } catch { return null; }
}

// ── Controlli ───────────────────────────────────────────────────────────

const root = (step: string) => ({ tipo: 'root' as const, comando: rootStep(step) });
const ui = (sezione: string) => ({ tipo: 'ui' as const, sezione });

async function claudeItem(): Promise<SetupItem> {
  const base = { id: 'claude', titolo: 'Accesso a Claude', rimedio: { tipo: 'utente' as const, comando: `${claudeBin()} auth login --claudeai` } };
  const st = await claudeAuthStatus();
  if (!st) return { ...base, stato: 'avviso', dettaglio: 'Non riesco a chiedere a Claude Code lo stato dell\'accesso.' };
  if (!st.loggedIn) return { ...base, stato: 'manca', dettaglio: 'Nessun login di claude.ai: senza, Ciccio e gli agenti non possono lavorare.' };
  if (/api|console/i.test(st.authMethod)) {
    return { ...base, stato: 'manca', dettaglio: `Accesso a consumo (${st.authMethod}): Ciccio usa solo il login con l'abbonamento claude.ai.` };
  }
  return { ...base, stato: 'ok', dettaglio: `Login di claude.ai${st.subscriptionType ? ` (${st.subscriptionType})` : ''}.` };
}

async function tailscaleItems(): Promise<SetupItem[]> {
  const origin = config.origins[0] ?? '';
  const host = (() => { try { return new URL(origin).hostname; } catch { return ''; } })();
  const onTailnet = host.endsWith('.ts.net');
  const ts = { id: 'tailscale', titolo: 'Tailscale', rimedio: root('tailscale') };
  const serve = { id: 'serve', titolo: 'HTTPS da Tailscale', rimedio: root('tailscale') };
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) {
    const dev = 'In sviluppo (indirizzo locale): sul server Ciccio si apre da Tailscale.';
    return [{ ...ts, stato: 'facoltativo', dettaglio: dev }, { ...serve, stato: 'facoltativo', dettaglio: dev }];
  }
  const st = await run('tailscale', ['status', '--json'], 4000);
  let tsItem: SetupItem;
  let dns = '';
  if (st.missing) tsItem = { ...ts, stato: onTailnet ? 'manca' : 'facoltativo', dettaglio: 'Tailscale non è installato.' };
  else {
    try {
      const j = JSON.parse(st.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
      dns = (j.Self?.DNSName ?? '').replace(/\.$/, '');
      if (j.BackendState !== 'Running') tsItem = { ...ts, stato: onTailnet ? 'manca' : 'avviso', dettaglio: `Tailscale non è collegato (stato: ${j.BackendState ?? 'sconosciuto'}).` };
      else if (onTailnet && dns && dns !== host) tsItem = { ...ts, stato: 'avviso', dettaglio: `Il server su Tailscale si chiama ${dns}, ma il primo indirizzo di CICCIO_ORIGINS è ${host}: le passkey e i link vanno sul nome giusto.` };
      else tsItem = { ...ts, stato: 'ok', dettaglio: dns ? `Collegato come ${dns}.` : 'Collegato.' };
    } catch {
      tsItem = { ...ts, stato: onTailnet ? 'manca' : 'avviso', dettaglio: `Tailscale non risponde: ${firstLine(st.stderr) || 'stato illeggibile'}.` };
    }
  }
  if (!onTailnet) {
    return [tsItem, { ...serve, stato: 'facoltativo', dettaglio: `Ciccio si apre da ${host}, non da Tailscale: l'HTTPS lo fa il dominio.` }];
  }
  if (tsItem.stato !== 'ok' && tsItem.stato !== 'avviso') return [tsItem, { ...serve, stato: 'manca', dettaglio: 'Prima serve Tailscale collegato.' }];
  const sv = await run('tailscale', ['serve', 'status', '--json'], 4000);
  if (!sv.ok) return [tsItem, { ...serve, stato: 'avviso', dettaglio: 'Non riesco a leggere la configurazione di tailscale serve senza root: se Ciccio si apre da Tailscale, è a posto.' }];
  // Basta un gestore web che passi alla porta di Ciccio.
  const port = String(config.port);
  const proxies = [...sv.stdout.matchAll(/"Proxy"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (proxies.some((p) => new RegExp(`:${port}(/|$)`).test(p))) return [tsItem, { ...serve, stato: 'ok', dettaglio: `https://${dns || host} porta a Ciccio (porta ${port}).` }];
  return [tsItem, { ...serve, stato: 'manca', dettaglio: proxies.length ? `tailscale serve porta a ${proxies.join(', ')}, non alla porta ${port} di Ciccio.` : 'tailscale serve non è configurato: senza, Ciccio non si apre in HTTPS.' }];
}

async function lingerItem(): Promise<SetupItem> {
  const base = { id: 'linger', titolo: 'Avvio senza login', rimedio: root('linger') };
  const user = os.userInfo().username;
  const r = await run('loginctl', ['show-user', '-p', 'Linger', user], 3000);
  if (r.missing) return { ...base, stato: 'facoltativo', dettaglio: 'Niente systemd qui: controllo saltato.' };
  if (/Linger=yes/.test(r.stdout)) return { ...base, stato: 'ok', dettaglio: 'Ciccio riparte da solo dopo un riavvio del server.' };
  return { ...base, stato: 'manca', dettaglio: 'Senza linger, Ciccio si ferma quando esci dal server e non riparte dopo un riavvio.' };
}

async function sandboxItem(): Promise<SetupItem> {
  const base = { id: 'sandbox', titolo: 'Sandbox dei comandi', rimedio: root('pacchetti') };
  if (process.platform !== 'linux') return { ...base, stato: 'facoltativo', dettaglio: 'La sandbox c\'è solo su Linux.' };
  const [b, s] = await Promise.all([run('bwrap', ['--ro-bind', '/', '/', 'true'], 4000), run('sh', ['-c', 'command -v socat'], 2000)]);
  if (b.missing) return { ...base, stato: 'manca', dettaglio: 'bubblewrap (bwrap) non è installato: i comandi degli agenti non hanno la sandbox.' };
  if (!b.ok) {
    return { ...base, rimedio: root('sistema'), stato: 'manca', dettaglio: `bwrap non parte (${firstLine(b.stderr) || 'errore'}): di solito AppArmor blocca i namespace utente.` };
  }
  if (!s.ok) return { ...base, stato: 'avviso', dettaglio: 'Manca socat: gli agenti non possono usare SSH attraverso il proxy.' };
  return { ...base, stato: 'ok', dettaglio: 'bwrap funziona e socat c\'è.' };
}

async function githubItems(): Promise<SetupItem[]> {
  const gh = { id: 'github', titolo: 'GitHub', rimedio: ui('github') };
  const git = { id: 'git', titolo: 'Identità git', rimedio: ui('git') };
  const [login, id] = await Promise.all([githubLogin(), gitIdentity()]);
  const ghMissing = login == null && (await run('gh', ['--version'], 2000)).missing;
  const ghItem: SetupItem = ghMissing ? { ...gh, rimedio: root('pacchetti'), stato: 'manca', dettaglio: 'gh (GitHub CLI) non è installato.' }
    : login == null ? { ...gh, stato: 'manca', dettaglio: 'gh non ha fatto l\'accesso: servono i repo per creare e importare progetti.' }
      : { ...gh, stato: 'ok', dettaglio: login ? `Accesso come ${login}.` : 'Accesso fatto.' };
  const gitItem: SetupItem = id.name && id.email ? { ...git, stato: 'ok', dettaglio: `${id.name} <${id.email}>` }
    : { ...git, stato: 'manca', dettaglio: 'Manca nome o email di git: i commit degli agenti non partono.' };
  return [ghItem, gitItem];
}

async function firewallItem(): Promise<SetupItem> {
  const base = { id: 'firewall', titolo: 'Firewall in uscita', rimedio: root('firewall') };
  if (process.platform !== 'linux') return { ...base, stato: 'facoltativo', dettaglio: 'Solo sul server Linux.' };
  const proxy = await active('tinyproxy', false);
  const ufw = readText('/etc/ufw/ufw.conf');
  const ufwOn = ufw == null ? null : /^\s*ENABLED\s*=\s*yes/m.test(ufw);
  if (!proxy) return { ...base, stato: 'manca', dettaglio: 'tinyproxy è spento: gli agenti escono su internet senza filtro.' };
  if (ufwOn === false) return { ...base, stato: 'avviso', dettaglio: 'Il proxy è acceso, ma ufw è spento: un agente può aggirarlo.' };
  return { ...base, stato: 'ok', dettaglio: ufwOn ? 'Proxy con elenco dei domini e ufw attivi.' : 'Proxy con elenco dei domini attivo (ufw non leggibile da qui).' };
}

async function helpersItem(): Promise<SetupItem> {
  const base = { id: 'helper', titolo: 'Aiuti da root', rimedio: root('helper') };
  if (process.platform !== 'linux') return { ...base, stato: 'facoltativo', dettaglio: 'Solo sul server Linux.' };
  const r = await Promise.all(HELPERS.map((h) => run('sudo', ['-n', '-l', `/usr/local/sbin/${h}`], 3000)));
  const off = HELPERS.filter((_, i) => !r[i].ok);
  const what: Record<string, string> = { 'ciccio-egress-allow': 'domini nuovi del proxy', 'ciccio-apt-install': 'programmi di sistema', 'ciccio-ssh-allow': 'server SSH da qui' };
  if (!off.length) return { ...base, stato: 'ok', dettaglio: 'Domini del proxy, programmi di sistema e server SSH si gestiscono da Ciccio.' };
  return { ...base, stato: 'avviso', dettaglio: `Spenti: ${off.map((h) => what[h]).join(', ')}. Gli agenti non potranno chiederli.` };
}

function sshItem(): SetupItem {
  const hosts = sshHosts();
  return {
    id: 'ssh', titolo: 'Server SSH', rimedio: ui('ssh'),
    stato: hosts.length ? 'ok' : 'facoltativo',
    dettaglio: hosts.length ? `${hosts.length} raggiungibili dagli agenti: ${hosts.slice(0, 4).join(', ')}${hosts.length > 4 ? '…' : ''}.` : 'Nessuno: gli agenti non possono collegarsi in SSH ad altri server.',
  };
}

function downloads() {
  try { return fs.readdirSync(path.join(config.dataDir, 'downloads')); } catch { return []; }
}

function companionItems(): SetupItem[] {
  const files = downloads();
  const pcs = companions();
  const apps = desktopApps();
  const compFiles = files.filter((f) => /^CiccioCompanion-/.test(f));
  const appFiles = files.filter((f) => /^Ciccio-(mac|windows)/.test(f));
  const onlinePcs = pcs.filter((p) => p.online);
  const out: SetupItem[] = [
    {
      id: 'companion', titolo: 'Companion dei PC', rimedio: compFiles.length ? ui('pc') : { tipo: 'utente', comando: 'bash ~/ciccio/deploy/fetch-release.sh', sezione: 'pc' },
      stato: pcs.length ? 'ok' : 'facoltativo',
      dettaglio: pcs.length ? `${pcs.length} PC collegati${onlinePcs.length ? `, accesi: ${onlinePcs.map((p) => p.name).join(', ')}` : ', nessuno acceso adesso'}.`
        : compFiles.length ? 'Nessun PC collegato: il companion fa usare agli agenti i programmi del tuo PC.' : 'Il programma non è ancora sul server (cartella downloads vuota): lo scarica dalla release firmata su GitHub deploy/fetch-release.sh.',
    },
    {
      id: 'app', titolo: 'App desktop', rimedio: appFiles.length ? ui('app') : { tipo: 'utente', comando: 'bash ~/ciccio/deploy/fetch-release.sh', sezione: 'app' },
      stato: apps.length ? 'ok' : 'facoltativo',
      dettaglio: apps.length ? `${apps.length} app collegate.` : appFiles.length ? 'Nessuna app collegata: Ciccio in una finestra sua, con le notifiche del sistema.' : 'L\'app non è ancora pubblicata sul server.',
    },
  ];
  if (pcs.length) {
    const ready = onlinePcs.filter((p) => p.onePassword?.sshAgent && p.onePassword.cli);
    out.push({
      id: 'onepassword', titolo: '1Password', rimedio: ui('credenziali'),
      stato: ready.length ? 'ok' : onlinePcs.length ? 'avviso' : 'facoltativo',
      dettaglio: ready.length ? `Agent SSH e CLI pronti su ${ready.map((p) => p.name).join(', ')}.`
        : onlinePcs.length ? `Su ${onlinePcs.map((p) => p.name).join(', ')} manca l'agent SSH o la CLI di 1Password.` : 'Si vede quando un PC con il companion è acceso.',
    });
  }
  return out;
}

async function voiceItem(): Promise<SetupItem> {
  let ok = false;
  try { ok = (await fetch(`${process.env.CICCIO_VOICE_URL ?? 'http://127.0.0.1:8791'}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* spento */ }
  return { id: 'voce', titolo: 'Voce sul server', rimedio: root('voce'), stato: ok ? 'ok' : 'facoltativo', dettaglio: ok ? 'Trascrizione e voce di Ciccio girano sul server.' : 'Servizio della voce spento: puoi usare un servizio esterno o il riconoscimento del browser.' };
}

function passkeyItem(): SetupItem {
  const n = authStore.credentials().length;
  const many = config.origins.length > 1 ? ` Ogni indirizzo (${config.origins.map((o) => new URL(o).host).join(', ')}) vuole le sue passkey.` : '';
  return {
    id: 'passkey', titolo: 'Passkey', rimedio: ui('accesso'),
    stato: n >= 2 ? 'ok' : n === 1 ? 'avviso' : 'manca',
    dettaglio: n >= 2 ? `${n} passkey registrate.${many}`
      : n === 1 ? `Una sola passkey: se perdi quel dispositivo resti fuori. Aggiungine una su un altro (Accesso › Aggiungi dispositivo); per rientrare senza, sul server: bash deploy/install.sh code.${many}`
        : 'Nessuna passkey registrata.',
  };
}

function generalItems(): SetupItem[] {
  const projects = store.agents().length;
  const saved = store.getKv<string>(OWNER_KEY) ?? null;
  const pending = saved && saved !== OWNER;
  // Fuso orario: CICCIO_TZ (se c'è) o quello del sistema.
  const tz = process.env.CICCIO_TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [
    {
      id: 'nome', titolo: 'Il tuo nome', rimedio: ui('nome'),
      stato: pending ? 'avviso' : OWNER === 'Utente' ? 'avviso' : 'ok',
      dettaglio: pending ? `«${saved}» vale dal prossimo riavvio di Ciccio (adesso: ${OWNER}).` : OWNER === 'Utente' ? 'Gli agenti ti chiamano «Utente»: dagli il tuo nome.' : `Gli agenti ti chiamano ${OWNER}.`,
    },
    {
      id: 'progetti', titolo: 'Progetti', rimedio: ui('progetti'),
      stato: projects ? 'ok' : 'facoltativo',
      dettaglio: projects ? `${projects} sul server.` : 'Nessun progetto ancora: creane uno o aggiungilo da GitHub.',
    },
    {
      id: 'fuso', titolo: 'Fuso orario', rimedio: { tipo: 'utente', comando: `echo 'CICCIO_TZ=${tz}' >> ~/.config/ciccio.env` },
      stato: 'ok', dettaglio: `${tz}${process.env.CICCIO_TZ ? ' (CICCIO_TZ)' : ' (quello del sistema)'}.`,
    },
  ];
}

async function domainItem(): Promise<SetupItem | null> {
  const pub = config.origins.map((o) => new URL(o)).filter((u) => u.protocol === 'https:' && !u.hostname.endsWith('.ts.net'));
  const base = { id: 'dominio', titolo: 'Dominio pubblico', rimedio: root('dominio') };
  if (!pub.length) return { ...base, stato: 'facoltativo', dettaglio: 'Solo da Tailscale. Con un dominio tuo Ciccio si apre anche fuori dalla tailnet (Caddy).' };
  const caddy = await active('caddy', false);
  return { ...base, stato: caddy ? 'ok' : 'manca', dettaglio: caddy ? `${pub.map((u) => u.host).join(', ')} con Caddy.` : `Caddy è spento: ${pub.map((u) => u.host).join(', ')} non risponde.` };
}

let cached: SetupReport | null = null;
let pending: Promise<SetupReport> | null = null;

async function build(): Promise<SetupReport> {
  const [claude, ts, linger, sandbox, gh, firewall, helpers, voice, domain] = await Promise.all([
    claudeItem(), tailscaleItems(), lingerItem(), sandboxItem(), githubItems(), firewallItem(), helpersItem(), voiceItem(), domainItem(),
  ]);
  const items: SetupItem[] = [
    claude, ...ts, linger, sandbox, firewall, helpers, ...gh, passkeyItem(), ...generalItems(), sshItem(), ...companionItems(), voice, ...(domain ? [domain] : []),
  ];
  return { items, mancano: items.filter((i) => i.stato === 'manca').length, at: Date.now(), origini: config.origins };
}

export async function setupReport(fresh = false): Promise<SetupReport> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached;
  pending ??= build().then((r) => { cached = r; return r; }).finally(() => { pending = null; });
  return pending;
}

/** Lancia l'helper root dei server SSH: 0 fatto, 1 rifiutato con il motivo su una riga di stderr. */
async function sshHelper(args: string[]): Promise<{ ok: boolean; message: string }> {
  const off = { ok: false, message: `L'helper ciccio-ssh-allow non è attivo: lancia sul server ${rootStep('helper')}.` };
  // Prima si chiede a sudo se l'helper è consentito senza password: così un rifiuto è davvero dell'helper.
  if (!(await run('sudo', ['-n', '-l', SSH_HELPER], 3000)).ok) return off;
  return run('sudo', ['-n', SSH_HELPER, ...args], 60_000).then((r) => {
    if (r.ok) return { ok: true, message: firstLine(r.stdout) };
    const err = `${r.stderr}`.trim();
    if (r.missing || /password is required|not allowed|may not run sudo|no new privileges|command not found|No such file/i.test(err)) return off;
    return { ok: false, message: firstLine(err.split('\n').pop() ?? '') || 'Rifiutato.' };
  });
}

export function registerSetup(app: FastifyInstance) {
  app.get<{ Querystring: { fresh?: string } }>('/api/setup', async (req) => setupReport(req.query.fresh === '1'));

  // Riavvio gentile (per il nome nuovo).
  app.post('/api/setup/restart', async () => ({ restart: scheduleRestart() }));

  app.get('/api/setup/github', async () => view(ghLogin));
  app.post('/api/setup/github', async () => startGithubLogin());
  app.post('/api/setup/github/cancel', async () => {
    ghLogin.proc?.kill('SIGTERM');
    ghLogin = { state: 'idle' };
    return view(ghLogin);
  });

  app.get('/api/setup/git', async () => ({ ...(await gitIdentity()), suggested: await gitSuggestion() }));
  app.post<{ Body: { name?: string; email?: string } }>('/api/setup/git', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    const email = String(req.body?.email ?? '').trim();
    if (!name || name.length > 100 || /[\n\r<>]/.test(name)) return reply.code(400).send({ error: 'Nome non valido.' });
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length > 200) return reply.code(400).send({ error: 'Email non valida.' });
    const a = await run('git', ['config', '--global', 'user.name', name]);
    const b = a.ok ? await run('git', ['config', '--global', 'user.email', email]) : a;
    if (!b.ok) return reply.code(500).send({ error: `git config non è riuscito: ${firstLine(b.stderr) || 'errore'}` });
    cached = null;
    return gitIdentity();
  });

  app.get('/api/setup/owner', async () => ({ active: OWNER, saved: store.getKv<string>(OWNER_KEY) ?? null, fallback: process.env.CICCIO_OWNER_NAME?.trim() || 'Utente' }));
  app.post<{ Body: { name?: string } }>('/api/setup/owner', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    const err = ownerNameError(name);
    if (err) return reply.code(400).send({ error: err });
    store.setKv(OWNER_KEY, name);
    cached = null;
    return { active: OWNER, saved: name, restartNeeded: name !== OWNER };
  });

  app.get('/api/setup/ssh-hosts', async () => ({ hosts: sshHosts() }));
  app.post<{ Body: { action?: string; host?: string } }>('/api/setup/ssh-hosts', async (req, reply) => {
    const action = req.body?.action;
    const host = String(req.body?.host ?? '').trim();
    if (action !== 'add' && action !== 'remove') return reply.code(400).send({ error: 'azione non valida' });
    const err = action === 'add' ? sshHostError(host) : sshHosts().includes(host) ? null : 'Server non in elenco.';
    if (err) return reply.code(400).send({ error: err });
    const r = await sshHelper([action, host]);
    if (!r.ok) return reply.code(400).send({ error: r.message });
    cached = null;
    return { hosts: sshHosts() };
  });
}
