// Prova dei ponti SSH da capo a fondo, senza binario: Ciccio (la parte companion e il socket del ponte di una chat)
// e il companion (collegamento a Ciccio, ponti consentiti nella config) nello stesso processo, con un server TCP
// d'eco al posto del server SSH dell'ufficio. Il socket della chat qui è una named pipe (Windows) o un socket Unix,
// e ci parla anche deploy/ssh-bridge.cjs, l'aiutante di ciccio-ssh-proxy.
// Destinazione non consentita, byte nei due versi (anche qualche MB), chiusura da una parte e dall'altra, collegamento
// che cade, al massimo 8 ponti, proposta con la finestra (finta) del PC, «No» ricordato, voce tolta, ponti inattivi.
//
//   pnpm exec tsx companion/test/ponte.ts

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-ponte-')));
process.env.CICCIO_DATA_DIR = path.join(tmp, 'data');
process.env.CICCIO_COMPANION_HOME = path.join(tmp, 'casa', '.ciccio-companion');

const { default: Fastify } = await import('fastify');
const { default: websocket } = await import('@fastify/websocket');
const { registerAuth, sha: shaOf } = await import('../../server/src/auth.js');
const { registerCompanion, companions, bridgesPrompt } = await import('../../server/src/companion.js');
const { openChatSshBridge } = await import('../../server/src/sshBridge.js');
const { config } = await import('../../server/src/config.js');
const { authStore } = await import('../../server/src/db.js');
const { loadConfig, templateConfig } = await import('../src/config.js');
const { LocalServers } = await import('../src/servers.js');
const { CiccioLink } = await import('../src/link.js');
const { PcBridges } = await import('../src/ponte.js');
const { BridgeTable } = await import('../../shared/node/ponte.js');
const { parseBridgeTarget } = await import('../../shared/companion.js');
type ChoiceRequest = import('../src/access.js').ChoiceRequest;

let failed = false;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failed = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (f: () => boolean, ms = 10_000) => { for (const t0 = Date.now(); !f(); ) { if (Date.now() - t0 > ms) return false; await sleep(50); } return true; };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const rejects = async (p: Promise<unknown>, re: RegExp, what: string) => {
  try { await p; ok(false, `${what} (nessun errore)`); } catch (e) { ok(re.test((e as Error).message), `${what}: ${(e as Error).message}`); }
};

// ── Destinazioni ─────────────────────────────────────────────────────────
ok(parseBridgeTarget('192.168.1.50')?.key === '192.168.1.50:22' && parseBridgeTarget('NAS.lan:2222')?.key === 'nas.lan:2222', 'host senza porta: 22; nomi in minuscolo');
ok(parseBridgeTarget('192.168.1.50', 2200)?.key === '192.168.1.50:2200' && !parseBridgeTarget('192.168.1.50:22', 22), 'porta a parte; non due volte');
ok(['', 'utente@host', 'host:0', 'host:70000', '999.1.1.1', '010.0.0.1', '::1', '[fe80::1]:22', 'a b', 'host-', 'host.-x', '-host'].every((v) => !parseBridgeTarget(v)), 'rifiutati: utente@, porte fuori scala, IPv4 finti, IPv6, spazi, trattini ai bordi');

// ── Server TCP al posto del server SSH dell'ufficio ──────────────────────
const echoConns = new Set<net.Socket>();
const echo = net.createServer((c) => { echoConns.add(c); c.on('close', () => echoConns.delete(c)); c.on('error', () => undefined); c.pipe(c); });
await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
const echoPort = (echo.address() as net.AddressInfo).port;
// Uno che saluta e chiude subito (chiusura dalla parte del server remoto).
const hello = net.createServer((c) => { c.on('error', () => undefined); c.end('SSH-2.0-finto\r\n'); });
await new Promise<void>((r) => hello.listen(0, '127.0.0.1', r));
const helloPort = (hello.address() as net.AddressInfo).port;
// Una porta dove non ascolta nessuno.
const closedPort = await new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const ECHO = `127.0.0.1:${echoPort}`;
const HELLO = `127.0.0.1:${helloPort}`;
const CLOSED = `127.0.0.1:${closedPort}`;

// ── Ciccio e il companion ────────────────────────────────────────────────
const app = Fastify();
await app.register(websocket);
registerAuth(app);
registerCompanion(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const server = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
const cookie = 'prova-sessione-ponte';
authStore.addSession(shaOf(cookie), Date.now() + 10 * 60_000, 'prova');
const sessionAuth = { cookie: `ciccio_s=${cookie}`, origin: config.origins[0] };
const created = (await app.inject({ method: 'POST', url: '/api/companions', headers: sessionAuth, payload: { name: 'ufficio' } })).json() as { token: string; device: { id: string } };

const home = process.env.CICCIO_COMPANION_HOME!;
fs.mkdirSync(home, { recursive: true });
const cfgPath = path.join(home, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ server, token: created.token, notifications: false, mcpServers: {}, ssh: { ponti: [ECHO, HELLO, CLOSED] } }, null, 2));
const cfg = loadConfig(cfgPath);
ok(cfg.ssh.ponti.length === 3, 'config con ssh.ponti valida');
fs.writeFileSync(path.join(tmp, 'vecchia.json'), JSON.stringify({ server, token: 'x', mcpServers: {} }));
ok(loadConfig(path.join(tmp, 'vecchia.json')).ssh.ponti.length === 0 && templateConfig('t', server).ssh.ponti.length === 0, 'config di prima e config nuova: nessun ponte');
fs.writeFileSync(path.join(tmp, 'rotta.json'), JSON.stringify({ server, token: 'x', mcpServers: {}, ssh: { ponti: ['utente@192.168.1.50'] } }));
try { loadConfig(path.join(tmp, 'rotta.json')); ok(false, 'voce non valida in ssh.ponti accettata'); } catch (e) { ok(/ssh/.test((e as Error).message), 'voce non valida in ssh.ponti: config rifiutata'); }

// Finestra finta del PC: risponde con quello che c'è in coda.
const asked: ChoiceRequest[] = [];
const replies: (string | null)[] = [];
const fakeChoose = async (req: ChoiceRequest) => { asked.push(req); return replies.shift() ?? null; };
const local = new LocalServers(cfgPath, cfg, { interactive: false });
const link = new CiccioLink(cfg.server, cfg.token, local.map, false, undefined, new PcBridges(cfgPath, fakeChoose));
local.onReloaded = () => link.bridgesChanged();
local.watch();
link.connect();
const pcView = () => companions().find((c) => c.name === 'ufficio');
ok(await wait(() => !!pcView()?.online && (pcView()?.sshBridges?.length ?? 0) === 3, 20_000), `PC collegato, ponti detti a Ciccio nel saluto: ${pcView()?.sshBridges?.join(', ')}`);
ok(bridgesPrompt().includes(`${ECHO}, ${HELLO}, ${CLOSED} (PC "ufficio")`), `riga per gli agenti: ${bridgesPrompt()}`);

// Il socket della chat: named pipe su Windows, socket Unix altrove.
const notes: string[] = [];
const chatAbort = new AbortController();
const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\ciccio-ponte-${randomBytes(6).toString('hex')}` : path.join(tmp, 'c1-ponte.sock');
const bridge = openChatSshBridge('c1', (t) => notes.push(t), chatAbort.signal, pipe);
await sleep(200);

/** Client del socket della chat come ciccio-ssh-proxy: la riga, la risposta e poi il socket per i byte. */
async function ask(target: string): Promise<{ line: string; sock: net.Socket; data: Buffer[]; closed: () => boolean }> {
  const [h, p] = target.split(':');
  const sock = net.connect(pipe);
  const data: Buffer[] = [];
  let closed = false;
  sock.on('close', () => { closed = true; });
  sock.on('error', () => undefined);
  sock.write(`${h} ${p}\n`);
  let buf = Buffer.alloc(0);
  const line = await new Promise<string>((resolve) => {
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      sock.off('data', onData);
      const rest = buf.subarray(nl + 1);
      if (rest.length) data.push(rest);
      sock.on('data', (d: Buffer) => data.push(d));
      resolve(buf.subarray(0, nl).toString());
    };
    sock.on('data', onData);
    sock.on('close', () => resolve(buf.toString() || '(chiuso)'));
  });
  return { line, sock, data, closed: () => closed };
}
const got = (c: { data: Buffer[] }) => Buffer.concat(c.data);

// ── Destinazioni non consentite ──────────────────────────────────────────
let c = await ask("127.0.0.1:1");
ok(c.line === 'NO', `destinazione che nessun PC consente: NO (il proxy va diretto) → ${c.line}`);
c = await ask('192.168.1.50:22');
ok(c.line === 'NO', 'server dell\'ufficio non consentito: NO');
c = await ask('utente@host 22');
ok(c.line === 'NO', 'riga non valida: NO');
const solo = new PcBridges(cfgPath, null);
await rejects(solo.connect("127.0.0.1", 1), /non è tra i ponti SSH consentiti/, 'il PC rifiuta da sé una destinazione non in ssh.ponti');
await rejects(solo.connect('localhost', echoPort), /non è tra i ponti/, 'il nome (localhost) non vale come l\'indirizzo consentito');
fs.writeFileSync(path.join(tmp, 'nome.json'), JSON.stringify({ server, token: 'x', mcpServers: {}, ssh: { ponti: [`localhost:${echoPort}`] } }));
await rejects(new PcBridges(path.join(tmp, 'nome.json'), null).connect('localhost', echoPort), /porta a .*questo PC/, 'nome consentito che porta al PC stesso (loopback): rifiutato');

// ── Byte nei due versi ───────────────────────────────────────────────────
c = await ask(ECHO);
ok(c.line === 'OK', `destinazione consentita: OK → ${c.line}`);
ok(await wait(() => notes.some((n) => n.includes(`ponte dal PC "ufficio" verso ${ECHO}`))), `riga nel registro della chat: ${notes.at(-1)}`);
c.sock.write('ciao\n');
ok(await wait(() => got(c).toString() === 'ciao\n'), 'pochi byte: andata e ritorno');
const big = randomBytes(4 * 1024 * 1024 + 123);
c.data.length = 0;
const t0 = Date.now();
c.sock.write(big);
ok(await wait(() => got(c).length >= big.length, 60_000) && sha(got(c)) === sha(big), `4 MB andata e ritorno, uguali (${Date.now() - t0} ms)`);
ok(echoConns.size === 1, 'una connessione al server remoto');
c.sock.end();
ok(await wait(() => echoConns.size === 0), 'chiuso dal client: il PC chiude la connessione al server remoto');
ok(await wait(() => notes.some((n) => n.includes(`ponte verso ${ECHO} chiuso`))), `riga di chiusura: ${notes.find((n) => n.includes('chiuso'))}`);

c = await ask(HELLO);
ok(c.line === 'OK' && await wait(() => c.closed()) && got(c).toString() === 'SSH-2.0-finto\r\n', 'chiuso dal server remoto: arriva quello che ha mandato, poi il client si chiude');

c = await ask(CLOSED);
ok(c.line.startsWith('ERR ') && /non raggiungibile/.test(c.line), `consentita ma nessuno ascolta: ${c.line}`);

// ── Al massimo 8 ponti per PC ────────────────────────────────────────────
const open: Awaited<ReturnType<typeof ask>>[] = [];
for (let i = 0; i < 8; i++) open.push(await ask(ECHO));
ok(open.every((x) => x.line === 'OK') && await wait(() => echoConns.size === 8), '8 ponti aperti insieme');
c = await ask(ECHO);
ok(c.line.startsWith('ERR') && /8 ponti/.test(c.line), `il nono: ${c.line}`);
for (const [i, x] of open.entries()) x.sock.write(`ponte ${i}\n`);
ok(await wait(() => open.every((x, i) => got(x).toString() === `ponte ${i}\n`)), 'ogni ponte riceve solo i suoi byte');

// ── Il collegamento cade ─────────────────────────────────────────────────
(link as unknown as { ws: { terminate(): void } }).ws.terminate();
ok(await wait(() => open.every((x) => x.closed())), 'collegamento caduto: i client dei ponti si chiudono');
ok(await wait(() => echoConns.size === 0), 'e il PC chiude le connessioni al server remoto');
ok(await wait(() => !!pcView()?.online, 20_000), 'il companion si ricollega');
c = await ask(ECHO);
c.sock.write('di nuovo\n');
ok(c.line === 'OK' && await wait(() => got(c).toString() === 'di nuovo\n'), 'dopo il ricollegamento i ponti funzionano');

// ── Fine del giro: i ponti della chat si chiudono ────────────────────────
bridge.close();
ok(await wait(() => c.closed() && echoConns.size === 0), 'giro finito: socket della chat chiuso, ponti chiusi anche sul PC');
const bridge2 = openChatSshBridge('c1', (t) => notes.push(t), chatAbort.signal, pipe);
await sleep(200);

// ── L'aiutante di ciccio-ssh-proxy ───────────────────────────────────────
const helper = path.resolve('deploy', 'ssh-bridge.cjs');
function runHelper(target: string, opts: { stdin?: number | 'pipe'; env?: Record<string, string> } = {}) {
  const [h, p] = target.split(':');
  const child = spawn(process.execPath, [helper, h, p], { env: { ...process.env, CICCIO_SSH_BRIDGE: pipe, ...opts.env }, stdio: [opts.stdin ?? 'pipe', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout!.on('data', (d: Buffer) => out.push(d));
  child.stderr!.on('data', (d: Buffer) => err.push(d));
  const done = new Promise<number>((r) => child.on('close', (code) => r(code ?? -1)));
  return { child, out, err, done };
}
let h = runHelper(ECHO);
h.child.stdin!.write('SSH-2.0-OpenSSH_prova\r\n');
ok(await wait(() => Buffer.concat(h.out).toString() === 'SSH-2.0-OpenSSH_prova\r\n'), 'aiutante: OK e poi stdin → ponte → stdout');
const big2 = randomBytes(2 * 1024 * 1024);
h.out.length = 0;
h.child.stdin!.write(big2);
ok(await wait(() => Buffer.concat(h.out).length >= big2.length, 60_000) && sha(Buffer.concat(h.out)) === sha(big2), 'aiutante: 2 MB andata e ritorno');
h.child.stdin!.end();
ok(await h.done === 0, 'aiutante: stdin chiuso → esce con 0');

// Con NO esce con 3 senza leggere stdin: quello che ssh ha già scritto resta per socat.
const inFile = path.join(tmp, 'stdin.txt');
fs.writeFileSync(inFile, 'SSH-2.0-OpenSSH_prova\r\n');
const fd = fs.openSync(inFile, 'r');
h = runHelper('192.168.1.50:22', { stdin: fd });
ok(await h.done === 3, 'aiutante: nessun ponte → esce con 3 (ciccio-ssh-proxy va diretto)');
const left = Buffer.alloc(100);
const n = fs.readSync(fd, left, 0, 100, null);
fs.closeSync(fd);
ok(left.subarray(0, n).toString() === 'SSH-2.0-OpenSSH_prova\r\n', 'aiutante: con NO stdin non è stato toccato');
h = runHelper(CLOSED);
ok(await h.done === 1 && /ciccio-ssh-proxy: ponte SSH verso .*non raggiungibile/.test(Buffer.concat(h.err).toString()), `aiutante: ERR → esce con 1 e il motivo su stderr: ${Buffer.concat(h.err).toString().trim()}`);
h = runHelper(ECHO, { env: { CICCIO_SSH_BRIDGE: process.platform === 'win32' ? '\\\\.\\pipe\\ciccio-non-c-e' : path.join(tmp, 'non-c-e.sock') } });
ok(await h.done === 3, 'aiutante: socket che non c\'è → 3 (diretto, come prima)');

// ── Proposte dal server: finestra del PC ─────────────────────────────────
const propose = async (action: 'propose' | 'remove', host: string) => {
  const r = await app.inject({ method: 'POST', url: `/api/companions/${created.device.id}/ssh-bridges`, headers: sessionAuth, payload: { action, host } });
  return { status: r.statusCode, body: r.json() as Record<string, unknown> };
};
replies.push('Consenti');
let r = await propose('propose', '192.168.1.50');
const shown = asked.at(-1);
ok(r.body.esito === 'consentito' && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).ssh.ponti.includes('192.168.1.50:22'), `«Consenti»: voce scritta nella config del PC (${JSON.stringify(r.body)})`);
ok(shown?.text.includes('Ciccio vuole collegarsi in SSH a 192.168.1.50:22 passando da questo PC') && shown.buttons.join() === 'Consenti,No', 'finestra: testo con la destinazione esatta, «Consenti» e «No» (ultimo)');
ok(pcView()?.sshBridges?.includes('192.168.1.50:22'), 'Ciccio sa subito del ponte nuovo');
r = await propose('propose', '192.168.1.50:22');
ok(r.body.esito === 'già' && asked.length === 1, 'già consentito: niente finestra');
replies.push('No');
r = await propose('propose', '10.0.0.7:2222');
ok(r.body.esito === 'rifiutato' && !JSON.parse(fs.readFileSync(cfgPath, 'utf8')).ssh.ponti.includes('10.0.0.7:2222'), '«No»: niente nella config');
r = await propose('propose', '10.0.0.7:2222');
ok(r.body.esito === 'rifiutato' && asked.length === 2, '«No» ricordato: la stessa proposta subito dopo non riapre la finestra');
replies.push(null);
r = await propose('propose', 'nas.ufficio.lan');
ok(r.body.esito === 'nessuna_risposta', 'finestra chiusa o scaduta: nessuna risposta');
r = await propose('propose', 'utente@host');
ok(r.status === 400, 'destinazione non valida: 400');

// Togliere una voce chiude anche i ponti aperti verso di lei.
c = await ask(ECHO);
ok(c.line === 'OK', 'ponte aperto prima di toglierlo');
r = await propose('remove', ECHO);
ok(r.body.tolto === true && !JSON.parse(fs.readFileSync(cfgPath, 'utf8')).ssh.ponti.includes(ECHO), '«Togli»: voce tolta dalla config del PC');
ok(await wait(() => c.closed() && echoConns.size === 0), 'il ponte aperto verso quella voce si chiude');
ok(await wait(() => !pcView()?.sshBridges?.includes(ECHO)), 'Ciccio non la offre più');
c = await ask(ECHO);
ok(c.line === 'NO', 'dopo «Togli»: NO');

// Voce aggiunta a mano nella config: il companion la rilegge da solo.
const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
raw.ssh.ponti.push(ECHO);
fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
ok(await wait(() => !!pcView()?.sshBridges?.includes(ECHO)), 'voce aggiunta a mano: Ciccio la sa senza ricollegare');

// ── ciccio-ssh-proxy (deploy/ssh-proxy.sh): prima il ponte, poi diretto ──
// socat finto: scrive come è stato chiamato e rimanda stdin. Su Windows il socket della chat è una named pipe, che
// «test -S» non riconosce: nella copia di prova il controllo diventa «-n» (su Linux resta quello vero).
if (spawnSync('sh', ['-c', 'command -v node >/dev/null'], { stdio: 'ignore' }).status !== 0) console.log('- sh o node non disponibili qui: ciccio-ssh-proxy non provato');
else {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const proxy = fs.readFileSync(path.resolve('deploy', 'ssh-proxy.sh'), 'utf8');
  ok(proxy.includes('[ -S "$b" ]'), 'ssh-proxy.sh controlla che CICCIO_SSH_BRIDGE sia un socket');
  fs.writeFileSync(path.join(bin, 'ciccio-ssh-proxy'), process.platform === 'win32' ? proxy.replace('[ -S "$b" ]', '[ -n "$b" ]') : proxy, { mode: 0o755 });
  fs.copyFileSync(path.resolve('deploy', 'ssh-bridge.cjs'), path.join(bin, 'ciccio-ssh-bridge.cjs'));
  fs.writeFileSync(path.join(bin, 'socat'), '#!/bin/sh\necho "socat $*"\nexec cat\n', { mode: 0o755 });
  const sep = process.platform === 'win32' ? ';' : ':';
  const runProxy = (target: string, input: string, env: Record<string, string | undefined>) => {
    const [hh, pp] = target.split(':');
    const child = spawn('sh', [path.join(bin, 'ciccio-ssh-proxy').replace(/\\/g, '/'), hh, pp], { env: { ...process.env, PATH: `${bin}${sep}${process.env.PATH}`, HTTPS_PROXY: 'http://127.0.0.1:3128', ...env } });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.stdin.write(input);
    const done = new Promise<number>((res) => child.on('close', (code) => res(code ?? -1)));
    return { child, out: () => Buffer.concat(out).toString(), err: () => Buffer.concat(err).toString(), done };
  };
  // 192.168.1.51: nessun PC lo consente (192.168.1.50 sì, dalla proposta di prima).
  let p = runProxy('192.168.1.51:22', 'SSH-2.0-prova\n', { CICCIO_SSH_BRIDGE: pipe });
  ok(await wait(() => p.out().includes('SSH-2.0-prova')), `nessun ponte: va diretto con socat, e la riga di ssh arriva intatta → ${p.out().replace(/\s+/g, ' ').trim()}`);
  ok(p.out().startsWith('socat - PROXY:127.0.0.1:192.168.1.51:22,proxyport=3128'), 'socat con il proxy della sandbox come prima');
  p.child.stdin.end();
  await p.done;
  p = runProxy(ECHO, 'SSH-2.0-prova\n', { CICCIO_SSH_BRIDGE: pipe });
  ok(await wait(() => p.out() === 'SSH-2.0-prova\n'), 'ponte consentito: passa dal PC (niente socat)');
  p.child.stdin.end();
  ok(await p.done === 0, 'e finisce con 0');
  p = runProxy(CLOSED, 'SSH-2.0-prova\n', { CICCIO_SSH_BRIDGE: pipe });
  ok(await p.done === 1 && !p.out().includes('socat') && /non raggiungibile/.test(p.err()), `ERR: si ferma con il motivo, senza andare diretto → ${p.err().trim()}`);
  p = runProxy('192.168.1.51:22', 'x', { CICCIO_SSH_BRIDGE: undefined });
  ok(await wait(() => p.out().startsWith('socat -')), 'senza CICCIO_SSH_BRIDGE: diretto come prima');
  p.child.stdin.end();
  await p.done;
}

// ── Ponte senza traffico: si chiude da solo ──────────────────────────────
const sent: unknown[] = [];
const table = new BridgeTable({ send: (m) => sent.push(m), buffered: () => 0 }, 300);
const s = net.connect(echoPort, '127.0.0.1');
await new Promise((res) => s.once('connect', res));
let why = '';
table.attach('p1', s, (reason) => { why = reason; });
ok(await wait(() => !table.has('p1'), 3000) && /nessun traffico/.test(why) && sent.some((m) => (m as { method?: string }).method === 'ssh/bridge-close'), `ponte inattivo chiuso: ${why}`);
table.stop('fine');

// ── Contropressione: WebSocket piena → socket fermi, poi ripartono ───────
let queued = 0;
const flood = net.createServer((x) => { x.on('error', () => undefined); const pump = () => { while (x.write(Buffer.alloc(64 * 1024))) { /* finché il socket accetta */ } }; pump(); x.on('drain', pump); });
await new Promise<void>((res) => flood.listen(0, '127.0.0.1', res));
const t2 = new BridgeTable({ send: () => { queued += 40_000; }, buffered: () => queued });
const f = net.connect((flood.address() as net.AddressInfo).port, '127.0.0.1');
await new Promise((res) => f.once('connect', res));
t2.attach('p2', f);
ok(await wait(() => f.isPaused(), 3000), `oltre 1 MB in coda sulla WebSocket: il socket si ferma (${Math.round(queued / 1024)} KB in coda)`);
const stuck = queued;
await sleep(200);
ok(queued === stuck, 'fermo: niente altri messaggi');
queued = 0;
ok(await wait(() => queued > 0, 3000), 'coda svuotata: riparte da solo (e si riferma quando si riempie)');
t2.stop('fine');
flood.close();

bridge2.close();
chatAbort.abort();
link.stop();
await local.stopAll();
await app.close();
echo.close();
hello.close();
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows: file ancora aperti */ }
console.log(failed ? '\nQUALCOSA NON VA' : '\nTutto ok');
process.exit(failed ? 1 : 0);
