// Prova da capo a fondo del companion compilato, su Mac e su Windows (anche in CI):
// Ciccio (solo la parte companion) in questo processo, il binario del companion come processo vero,
// un server MCP stdio lanciato con npx, una chiamata a uno strumento e la chiusura con "stop".
//
//   pnpm exec tsx companion/test/e2e.ts dist/companion/ciccio-companion-darwin-arm64
//   pnpm exec tsx companion/test/e2e.ts dist\companion\ciccio-companion-windows-x64.exe
// (su Windows "pair" installa anche l'avvio automatico: la prova lo toglie alla fine)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exe = path.resolve(process.argv[2] ?? '');
if (!fs.existsSync(exe)) { console.error(`Binario non trovato: ${exe}`); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-e2e-'));
process.env.CICCIO_DATA_DIR = path.join(tmp, 'data');
const home = path.join(tmp, 'companion home'); // con uno spazio, come C:\Users\Nome Cognome
const env = { ...process.env, CICCIO_COMPANION_HOME: home };
const cfgPath = path.join(home, 'config.json');

const { default: Fastify } = await import('fastify');
const { default: websocket } = await import('@fastify/websocket');
const { registerCompanion, pcMcpServers, companions, releasePcServers } = await import('../../server/src/companion.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

let failed = false;
const ok = (cond: unknown, what: string) => {
  console.log(`${cond ? '✓' : '✗'} ${what}`);
  if (!cond) failed = true;
};
const wait = async (f: () => boolean, ms: number) => {
  for (const t0 = Date.now(); !f(); ) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
};

/** Processi ancora vivi che contengono questo testo nella riga di comando. */
function processesWith(text: string): number {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${text}*' -and $_.Name -ne 'powershell.exe' }).Count`], { encoding: 'utf8' });
      return Number(out.trim()) || 0;
    }
    return execFileSync('pgrep', ['-f', text], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
  } catch { return 0; }
}

const app = Fastify();
await app.register(websocket);
registerCompanion(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const port = (app.server.address() as { port: number }).port;

const created = (await app.inject({ method: 'POST', url: '/api/companions', payload: { name: 'prova' } })).json() as { token: string };
ok(created.token?.startsWith('ccp_'), 'token del dispositivo generato');

// Abbinamento come dal pulsante «Collega questo PC»: un link http verso un altro computer, uno con token
// sbagliato, quello buono, poi un link verso un altro server (rifiutato: il PC è già collegato a questo).
const server = `http://127.0.0.1:${port}`;
// Asincrono: il Ciccio di prova gira in questo processo e deve poter rispondere al controllo del token.
const pairWith = async (token: string, srv = server) => {
  try {
    const r = await promisify(execFile)(exe, ['pair', `ciccio-companion://pair?token=${token}&server=${encodeURIComponent(srv)}`, '--yes', '--config', cfgPath], { env, encoding: 'utf8' });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) { const x = e as { code: number; stdout: string; stderr: string }; return { code: x.code, out: x.stdout + x.stderr }; }
};
const plain = await pairWith(created.token, 'http://altro.example.com');
ok(plain.code !== 0 && /Server non riconosciuto/.test(plain.out) && !fs.existsSync(cfgPath), 'primo abbinamento: link http verso un altro computer rifiutato');
const wrong = await pairWith('ccp_' + 'x'.repeat(43));
ok(wrong.code !== 0 && /non riconosce/.test(wrong.out) && !fs.existsSync(cfgPath), `token sbagliato rifiutato, config non creata (${wrong.code}: ${wrong.out.trim().split('\n').pop()})`);
const good = await pairWith(created.token);
ok(good.code === 0 && fs.existsSync(cfgPath), 'abbinamento con il link riuscito');
const foreign = await pairWith(created.token, 'https://altro.example.com');
ok(foreign.code !== 0 && /Server non riconosciuto/.test(foreign.out) && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).server === server, 'PC collegato: link verso un altro server rifiutato, config intatta');
if (process.platform === 'win32') {
  // Su Windows l'abbinamento ha già acceso il companion in background: qui serve quello in primo piano.
  ok(/è acceso/.test(good.out), 'su Windows l\'abbinamento accende l\'icona e il companion');
  execFileSync(exe, ['stop'], { env, stdio: 'inherit' });
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.mcpServers = {
  everything: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything@2026.8.31', 'stdio'] },
  affinity: cfg.mcpServers.affinity,
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
if (process.platform !== 'win32') ok((fs.statSync(cfgPath).mode & 0o077) === 0, 'config leggibile solo dall’utente');

const child = spawn(exe, ['run', '--config', cfgPath], { env, stdio: 'inherit' });
const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));

const online = await wait(() => {
  const c = companions().find((x) => x.name === 'prova');
  return !!c?.online && !!c.servers.find((s) => s.name === 'everything' && s.status === 'online' && s.tools.length > 0);
}, 120_000);
ok(online, 'companion collegato con il server "everything"');

if (online) {
  ok(companions()[0].platform?.startsWith(process.platform), `piattaforma riportata: ${companions()[0].platform}`);
  const servers = pcMcpServers();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await servers.pc_prova.instance.connect(b);
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(a);
  const names = (await client.listTools()).tools.map((t) => t.name);
  ok(names.includes('everything_echo'), `strumenti esposti come pc_prova__everything_* (${names.length})`);
  const res = await client.callTool({ name: 'everything_echo', arguments: { message: 'ciao da Ciccio' } }) as { content: { type: string; text?: string }[] };
  ok(JSON.stringify(res.content).includes('ciao da Ciccio'), 'chiamata inoltrata al PC e risposta tornata');
  await client.close();
  releasePcServers(servers);
  ok(processesWith('server-everything') > 0, 'server MCP figlio acceso');
}

// "stop" da un altro processo: il companion deve chiudersi bene e portarsi via i server figli.
const stopOut = execFileSync(exe, ['stop'], { env, encoding: 'utf8' });
ok(/chiuso/.test(stopOut), `stop: ${stopOut.trim()}`);
const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000))]);
ok(code === 0, `companion uscito (codice ${code})`);
ok(await wait(() => processesWith('server-everything') === 0, 10_000), 'nessun server MCP orfano');
ok(await wait(() => !companions()[0].online, 5000), 'Ciccio lo vede spento');
// Da spento gli strumenti restano nell'elenco delle sessioni, uguali: se sparissero, ogni chat perderebbe la cache.
const offline = pcMcpServers();
ok(!!offline.pc_prova?.tools?.some((t) => t.name === 'everything_echo'), 'strumenti del PC spento ancora nell’elenco');
releasePcServers(offline);
ok(!fs.existsSync(path.join(home, 'companion.pid')), 'file PID tolto');

if (process.platform === 'win32') execFileSync(exe, ['uninstall'], { env, stdio: 'inherit' });
await app.close();
// Su Windows i file appena chiusi restano bloccati per qualche istante: la pulizia non deve far fallire la prova.
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { console.log(`(cartella temporanea non tolta: ${(e as Error).message})`); }
console.log(failed ? '\nPROVA FALLITA' : '\nPROVA RIUSCITA');
process.exit(failed ? 1 : 0);
