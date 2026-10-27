// Prova di scarica_da_ciccio e carica_su_ciccio da capo a fondo, senza binario: Ciccio (la parte companion,
// con il controllo degli accessi di Caddy) e il companion (server «file», collegamento a Ciccio) nello stesso
// processo, una sessione come quella di un agente con il repo del suo progetto. Percorsi fuori dal repo, .git,
// collegamenti, sovrascritture con backup, cartelle in sola lettura, token monouso e di un altro PC.
//
//   pnpm exec tsx companion/test/transfer.ts

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-transfer-')));
process.env.CICCIO_DATA_DIR = path.join(tmp, 'data');
process.env.CICCIO_COMPANION_HOME = path.join(tmp, 'casa', '.ciccio-companion');
const repo = path.join(tmp, 'progetti', 'pezzo');
const altroRepo = path.join(tmp, 'progetti', 'altro');
const pc = path.join(tmp, 'Desktop', 'stampe');
const sola = path.join(tmp, 'OneDrive', 'Modelli');
const fuori = path.join(tmp, 'fuori');
for (const d of [path.join(repo, 'out'), path.join(repo, '.git'), altroRepo, pc, sola, fuori]) fs.mkdirSync(d, { recursive: true });
const stl = Buffer.from(`solid cubo\n${'facet normal 0 0 1\n'.repeat(2000)}endsolid cubo\n`);
fs.writeFileSync(path.join(repo, 'out', 'cubo.stl'), stl);
fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]');
fs.writeFileSync(path.join(altroRepo, 'segreto.txt'), 'di un altro progetto');
fs.writeFileSync(path.join(fuori, 'segreto.txt'), 'fuori');
fs.writeFileSync(path.join(sola, 'modello.3mf'), 'TREEMMEFFE');
// Collegamento nel repo che porta fuori (junction su Windows).
fs.symlinkSync(fuori, path.join(repo, 'scorciatoia'), 'junction');

const { default: Fastify } = await import('fastify');
const { default: websocket } = await import('@fastify/websocket');
const { registerAuth } = await import('../../server/src/auth.js');
const { registerCompanion, pcMcpServers, companions, releasePcServers } = await import('../../server/src/companion.js');
const { decide } = await import('../../server/src/policy.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { loadConfig } = await import('../src/config.js');
const { LocalServers } = await import('../src/servers.js');
const { ciccioTransfer } = await import('../src/transfer.js');
const { CiccioLink } = await import('../src/link.js');

let failed = false;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failed = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (f: () => boolean, ms: number) => { for (const t0 = Date.now(); !f(); ) { if (Date.now() - t0 > ms) return false; await sleep(100); } return true; };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const app = Fastify();
await app.register(websocket);
registerAuth(app);
registerCompanion(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const port = (app.server.address() as { port: number }).port;
const server = `http://127.0.0.1:${port}`;
// Ciccio vuole il login anche qui: i dispositivi li crea il test con una sessione, come la pagina dopo la passkey.
// Il token locale degli script del server non basta: vale solo per poche letture.
const { config } = await import('../../server/src/config.js');
const { authStore } = await import('../../server/src/db.js');
const { sha: shaOf } = await import('../../server/src/auth.js');
const localToken = { 'x-ciccio-local': fs.readFileSync(path.join(config.dataDir, 'local-token'), 'utf8') };
const intruder = (await app.inject({ method: 'POST', url: '/api/companions', headers: localToken, payload: { name: 'intruso' } })).statusCode;
ok(intruder === 401 || intruder === 403, `token locale: niente companion nuovi (HTTP ${intruder})`);
const cookie = 'prova-sessione';
authStore.addSession(shaOf(cookie), Date.now() + 60_000, 'prova');
const sessionAuth = { cookie: `ciccio_s=${cookie}`, origin: config.origins[0] };
const created = (await app.inject({ method: 'POST', url: '/api/companions', headers: sessionAuth, payload: { name: 'prova' } })).json() as { token: string };
const other = (await app.inject({ method: 'POST', url: '/api/companions', headers: sessionAuth, payload: { name: 'altro' } })).json() as { token: string };

const home = process.env.CICCIO_COMPANION_HOME!;
fs.mkdirSync(home, { recursive: true });
const cfgPath = path.join(home, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  server, token: created.token, notifications: false,
  mcpServers: { file: { type: 'builtin', builtin: 'file', roots: [{ path: pc, backup: '_vecchie' }, { path: sola, solaLettura: true }] } },
}, null, 2));
const cfg = loadConfig(cfgPath);
const local = new LocalServers(cfgPath, cfg, { interactive: false, transfer: ciccioTransfer(cfg.server, cfg.token) });
const link = new CiccioLink(cfg.server, cfg.token, local.map, false);
void local.startAll();
link.connect();
ok(await wait(() => !!companions().find((x) => x.name === 'prova')?.servers.find((s) => s.name === 'file' && s.status === 'online'), 20_000), 'companion collegato con il server file');

type Res = { isError?: boolean; content: { type: string; text?: string }[] };
const textOf = (r: Res) => r.content.map((c) => c.text ?? '').join('');
const jsonOf = (r: Res) => { try { return JSON.parse(textOf(r)) as Record<string, any>; } catch { return {}; } };
async function session(ctx?: { repoDir: string; who: string }) {
  const servers = pcMcpServers(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await servers.pc_prova.instance.connect(b);
  const client = new Client({ name: 'prova', version: '1' });
  await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as Res;
  return { client, call, close: async () => { await client.close(); releasePcServers(servers); } };
}

const s = await session({ repoDir: repo, who: 'pezzo / prova' });
const tools = (await s.client.listTools()).tools;
const dl = tools.find((t) => t.name === 'file_scarica_da_ciccio');
ok(dl && tools.some((t) => t.name === 'file_carica_su_ciccio') && !('_meta' in dl), 'strumenti file_scarica_da_ciccio e file_carica_su_ciccio esposti (senza _meta interni)');
ok(decide('auto', 'mcp__pc_prova__file_scarica_da_ciccio', {}, repo, { readOnly: false }).action === 'ask', 'policy: in automatico chiedono il permesso (azioni sul PC)');
ok(decide('auto', 'mcp__pc_prova__comandi_list_files', {}, repo, { readOnly: false }).action === 'ask' && decide('auto', 'mcp__pc_prova__chrome_list_pages', {}, repo, {}).action === 'allow', 'policy: un\'azione dichiarata chiede anche se si chiama list_…; senza dichiarazione conta il nome');

// ── Dal repo al PC ───────────────────────────────────────────────────────
const dest = path.join(pc, 'cubo.stl');
let r = await s.call('file_scarica_da_ciccio', { file_sul_server: 'out/cubo.stl', destinazione: dest });
ok(!r.isError && fs.readFileSync(dest).equals(stl) && jsonOf(r).sha256 === sha(stl), `scaricato sul PC: ${textOf(r).replace(/\s+/g, ' ').slice(0, 140)}`);
ok(fs.readdirSync(pc).every((n) => !n.includes('ciccio-tmp')), 'nessun file temporaneo rimasto');
r = await s.call('file_scarica_da_ciccio', { file_sul_server: 'out/cubo.stl', destinazione: dest });
ok(r.isError && /esiste già/.test(textOf(r)), 'destinazione che esiste: rifiutata senza sovrascrivi');
fs.writeFileSync(path.join(repo, 'out', 'cubo.stl'), 'versione 2');
r = await s.call('file_scarica_da_ciccio', { file_sul_server: 'out/cubo.stl', destinazione: dest, sovrascrivi: true });
ok(!r.isError && fs.readFileSync(dest, 'utf8') === 'versione 2' && fs.readFileSync(path.join(pc, '_vecchie', 'cubo.stl')).equals(stl), 'sovrascrivi=true: sostituito, la versione di prima nel backup');
r = await s.call('file_scarica_da_ciccio', { file_sul_server: 'out/cubo.stl', destinazione: path.join(sola, 'cubo.stl') });
ok(r.isError && /sola lettura/.test(textOf(r)) && !fs.existsSync(path.join(sola, 'cubo.stl')), 'verso una cartella in sola lettura: rifiutato');
r = await s.call('file_scarica_da_ciccio', { file_sul_server: 'out/cubo.stl', destinazione: path.join(fuori, 'cubo.stl') });
ok(r.isError && /fuori dalle cartelle consentite/.test(textOf(r)) && !fs.existsSync(path.join(fuori, 'cubo.stl')), 'verso una cartella non consentita: rifiutato');
r = await s.call('file_scarica_da_ciccio', { file_sul_server: '../altro/segreto.txt', destinazione: path.join(pc, 'x.txt') });
ok(r.isError && /dentro il repo/.test(textOf(r)) && !fs.existsSync(path.join(pc, 'x.txt')), 'file di un altro progetto (../): rifiutato da Ciccio');
r = await s.call('file_scarica_da_ciccio', { file_sul_server: path.join(altroRepo, 'segreto.txt'), destinazione: path.join(pc, 'x.txt') });
ok(r.isError && /dentro il repo/.test(textOf(r)), 'percorso assoluto fuori dal repo: rifiutato');
r = await s.call('file_scarica_da_ciccio', { file_sul_server: 'scorciatoia/segreto.txt', destinazione: path.join(pc, 'x.txt') });
ok(r.isError && /dentro il repo/.test(textOf(r)) && !fs.existsSync(path.join(pc, 'x.txt')), 'collegamento nel repo che porta fuori: rifiutato');
r = await s.call('file_scarica_da_ciccio', { file_sul_server: '.git/config', destinazione: path.join(pc, 'x.txt') });
ok(r.isError && /\.git/.test(textOf(r)), '.git: rifiutato');
r = await s.call('file_scarica_da_ciccio', { file_sul_server: 'out/non-c-e.stl', destinazione: path.join(pc, 'x.txt') });
ok(r.isError && /non c'è/.test(textOf(r)), 'file che non c\'è: errore chiaro');

// ── Dal PC al repo ───────────────────────────────────────────────────────
r = await s.call('file_carica_su_ciccio', { file_sul_pc: path.join(sola, 'modello.3mf'), destinazione_sul_server: 'dal-pc/modello.3mf' });
ok(!r.isError && fs.readFileSync(path.join(repo, 'dal-pc', 'modello.3mf'), 'utf8') === 'TREEMMEFFE' && jsonOf(r).nelRepo === 'dal-pc/modello.3mf', `caricato nel repo (da una cartella in sola lettura): ${textOf(r).replace(/\s+/g, ' ').slice(0, 140)}`);
r = await s.call('file_carica_su_ciccio', { file_sul_pc: path.join(sola, 'modello.3mf'), destinazione_sul_server: 'dal-pc/modello.3mf' });
ok(r.isError && /c'è già/.test(textOf(r)), 'file che c\'è già nel repo: rifiutato senza sovrascrivi');
r = await s.call('file_carica_su_ciccio', { file_sul_pc: dest, destinazione_sul_server: 'dal-pc/modello.3mf', sovrascrivi: true });
ok(!r.isError && fs.readFileSync(path.join(repo, 'dal-pc', 'modello.3mf'), 'utf8') === 'versione 2', 'sovrascrivi=true: sostituito');
r = await s.call('file_carica_su_ciccio', { file_sul_pc: dest, destinazione_sul_server: '.git/hooks/pre-commit' });
ok(r.isError && !fs.existsSync(path.join(repo, '.git', 'hooks')), 'dentro .git: rifiutato');
for (const dove of ['.claude/settings.json', 'sotto/.claude/hooks/x.sh', '.mcp.json', 'pkg/.mcp.json', '.gitmodules', '.ciccio/worktrees/abc/src/x.ts']) {
  r = await s.call('file_carica_su_ciccio', { file_sul_pc: dest, destinazione_sul_server: dove });
  ok(r.isError && !fs.existsSync(path.join(repo, dove)), `${dove}: rifiutato (decide hook, permessi o server MCP)`);
}
r = await s.call('file_carica_su_ciccio', { file_sul_pc: dest, destinazione_sul_server: '../altro/nuovo.txt' });
ok(r.isError && !fs.existsSync(path.join(altroRepo, 'nuovo.txt')), 'fuori dal repo: rifiutato');
r = await s.call('file_carica_su_ciccio', { file_sul_pc: dest, destinazione_sul_server: 'scorciatoia/nuovo.txt' });
ok(r.isError && !fs.existsSync(path.join(fuori, 'nuovo.txt')), 'attraverso un collegamento del repo: rifiutato');
r = await s.call('file_carica_su_ciccio', { file_sul_pc: path.join(fuori, 'segreto.txt'), destinazione_sul_server: 'rubato.txt' });
ok(r.isError && /fuori dalle cartelle consentite/.test(textOf(r)) && !fs.existsSync(path.join(repo, 'rubato.txt')), 'file del PC fuori dalle cartelle consentite: rifiutato dal companion');
r = await s.call('file_carica_su_ciccio', { file_sul_pc: path.join(cfgPath), destinazione_sul_server: 'config.json' });
ok(r.isError && !fs.existsSync(path.join(repo, 'config.json')), 'la config del companion (con il token) non si carica');
ok(!fs.readdirSync(path.join(repo, 'dal-pc')).some((n) => n.includes('.ciccio-')), 'nessun file temporaneo nel repo');
await s.close();

// ── Senza progetto, token e rotte ────────────────────────────────────────
const s2 = await session();
r = await s2.call('file_scarica_da_ciccio', { file_sul_server: 'out/cubo.stl', destinazione: path.join(pc, 'y.stl') });
ok(r.isError && /agenti dei progetti/.test(textOf(r)), 'sessione senza progetto (Ciccio): niente scambio di file');
await s2.close();
const fake = 'A'.repeat(43);
let res = await app.inject({ method: 'GET', url: `/companion/transfer/${fake}`, headers: { authorization: `Bearer ${created.token}` } });
ok(res.statusCode === 404, 'token sconosciuto: 404');
res = await app.inject({ method: 'GET', url: `/companion/transfer/${fake}` });
ok(res.statusCode === 401, 'senza token del dispositivo: 401');
// Il PUT del companion passa senza Origin (niente cookie), ma serve sempre il token.
res = await app.inject({ method: 'PUT', url: `/companion/transfer/${fake}`, headers: { 'x-ciccio-proxy': '1', 'content-type': 'application/octet-stream', authorization: `Bearer ${created.token}` }, payload: Buffer.from('x') });
ok(res.statusCode === 404, `via Caddy il PUT del trasferimento arriva alla rotta (HTTP ${res.statusCode})`);
res = await app.inject({ method: 'POST', url: '/api/companions', headers: { 'content-type': 'application/json' }, payload: '{"name":"senza"}' });
ok(res.statusCode === 403, 'le altre rotte chiedono sempre l\'Origin');
// Indirizzo codificato (/%61pi = /api): il router lo porta alla stessa rotta, che chiede comunque l'accesso.
res = await app.inject({ method: 'GET', url: '/%61pi/companions' });
ok(res.statusCode === 401, `indirizzo codificato: accesso richiesto (HTTP ${res.statusCode})`);

// Token preso da un altro PC o usato due volte: il token monouso si intercetta a metà, in una chiamata vera.
let captured: { token?: string } = {};
const s3 = await session({ repoDir: repo, who: 'pezzo / prova' });
const spy = local.map.get('file')!;
const realCall = spy.call.bind(spy);
spy.call = async (name, args, signal, transfer) => { captured = { token: transfer?.token }; return realCall(name, args, signal, transfer); };
r = await s3.call('file_scarica_da_ciccio', { file_sul_server: 'out/cubo.stl', destinazione: path.join(pc, 'z.stl') });
ok(!r.isError && !!captured.token, 'scaricato (token intercettato per la prova)');
res = await app.inject({ method: 'GET', url: `/companion/transfer/${captured.token}`, headers: { authorization: `Bearer ${created.token}` } });
ok(res.statusCode === 404, 'lo stesso token una seconda volta: 404 (monouso)');
spy.call = async (name, args, signal, transfer) => {
  // Un altro PC prova a usare il token prima del companion giusto.
  const stolen = await app.inject({ method: 'GET', url: `/companion/transfer/${transfer?.token}`, headers: { authorization: `Bearer ${other.token}` } });
  captured = { token: String(stolen.statusCode) };
  return realCall(name, args, signal, transfer);
};
r = await s3.call('file_scarica_da_ciccio', { file_sul_server: 'out/cubo.stl', destinazione: path.join(pc, 'w.stl') });
ok(captured.token === '404' && !r.isError, 'token usato da un altro PC: 404, e al PC giusto arriva comunque');
spy.call = realCall;
await s3.close();

link.stop();
await local.stopAll();
await app.close();
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows: file ancora aperti */ }
console.log(failed ? '\nQUALCOSA NON VA' : '\nTutto ok');
process.exit(failed ? 1 : 0);
