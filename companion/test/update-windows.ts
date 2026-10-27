// Prova dell'aggiornamento automatico su Windows (CI "Companion Windows"):
// icona e companion installati alla versione attuale, Ciccio di prova in questo processo con
// downloads/companion.json a una versione più alta, e il controllo che l'icona sostituisca gli .exe
// e riparta alla versione nuova (icona e companion) senza finestre e senza lasciare copie .old.
// Prima un manifest firmato con un'altra chiave: il companion lo deve rifiutare e restare com'è.
//
//   CICCIO_RELEASE_KEY_FILE=<chiave usa e getta> pnpm exec tsx companion/test/update-windows.ts <exe attuale> <exe nuovo (VERSION 9.9.9)>
// I due .exe vanno compilati con la chiave pubblica di quella chiave in shared/release-key.ts (lo fa la CI).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

if (process.platform !== 'win32') { console.log('Prova solo per Windows.'); process.exit(0); }
const [current, next] = process.argv.slice(2).map((p) => path.resolve(p));
const NEXT_VERSION = '9.9.9';
const keyFile = process.env.CICCIO_RELEASE_KEY_FILE;
if (!keyFile) { console.error('Serve CICCIO_RELEASE_KEY_FILE: la chiave privata usa e getta con cui sono compilati i due .exe.'); process.exit(1); }
const releaseKey = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'release-key.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-upd-'));
process.env.CICCIO_DATA_DIR = path.join(tmp, 'data');
const home = path.join(tmp, 'companion home');
const env = { ...process.env, CICCIO_COMPANION_HOME: home };
const cfgPath = path.join(home, 'config.json');
const bin = path.join(home, 'bin');
const run = promisify(execFile);

// Versione nuova pubblicata come fa la release (scripts/release-key.mjs manifest), per ora con una chiave
// che il companion non conosce: deve rifiutarla.
const downloads = path.join(process.env.CICCIO_DATA_DIR, 'downloads');
fs.mkdirSync(downloads, { recursive: true });
const nextBytes = fs.readFileSync(next);
fs.writeFileSync(path.join(downloads, 'CiccioCompanion-windows.exe'), nextBytes);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const publish = (key: string) => execFileSync(process.execPath, [releaseKey, 'manifest', 'companion', NEXT_VERSION, downloads, 'win32-x64=CiccioCompanion-windows.exe', '--chiave', key], { stdio: 'inherit' });
const otherKey = path.join(tmp, 'altra-chiave.pem');
fs.writeFileSync(otherKey, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
publish(otherKey);

const { default: Fastify } = await import('fastify');
const { default: websocket } = await import('@fastify/websocket');
const { registerCompanion, companions } = await import('../../server/src/companion.js');

let failed = false;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failed = true; };
const wait = async (f: () => boolean, ms: number) => {
  for (const t0 = Date.now(); !f(); ) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 500)); }
  return true;
};
const pidNow = () => { try { return Number(fs.readFileSync(path.join(home, 'companion.pid'), 'utf8').trim()) || null; } catch { return null; } };
const log = () => { try { return fs.readFileSync(path.join(home, 'companion.log'), 'utf8'); } catch { return ''; } };

const app = Fastify();
await app.register(websocket);
registerCompanion(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const port = (app.server.address() as { port: number }).port;
const { token } = (await app.inject({ method: 'POST', url: '/api/companions', payload: { name: 'aggiorna' } })).json() as { token: string };

// Installazione della versione attuale (asincrono: il Ciccio di prova gira in questo processo).
await run(current, ['init', token, '--server', `http://127.0.0.1:${port}`, '--config', cfgPath], { env });
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.mcpServers = {};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
const installed = await run(current, ['install', '--config', cfgPath], { env });
console.log(installed.stdout.trim());
const trayPid = () => { try { return Number(fs.readFileSync(path.join(home, 'tray.pid'), 'utf8').trim()) || null; } catch { return null; } };
await wait(() => !!pidNow(), 20_000);
const firstPid = pidNow();
const firstTray = trayPid();
ok(firstPid && firstTray, `versione attuale accesa: icona (PID ${firstTray}) e companion (PID ${firstPid})`);

const view = () => companions().find((c) => c.name === 'aggiorna');
// Manifest firmato con un'altra chiave: rifiutato, niente scaricato, stesso processo.
ok(await wait(() => /firma del manifest non valida/.test(log()), 60_000), 'manifest firmato con un\'altra chiave: rifiutato');
ok(pidNow() === firstPid && !fs.existsSync(path.join(home, 'updates', 'CiccioCompanion-windows.exe')), 'nessun aggiornamento scaricato né installato');
// Ora con la chiave giusta: Ciccio lo offre di nuovo appena companion.json cambia.
publish(keyFile);
const updated = await wait(() => !!view()?.online && view()?.version === NEXT_VERSION, 180_000);
console.log(log());
ok(updated, `Ciccio vede il companion alla versione ${NEXT_VERSION} (${view()?.version})`);
const newPid = pidNow();
ok(newPid && newPid !== firstPid, `è ripartito con un altro processo (PID ${firstPid} → ${newPid})`);
ok(/aggiornata alla versione 9\.9\.9/.test(log()), 'registro: passaggio di mano tra le icone');
ok(trayPid() && trayPid() !== firstTray, `icona nuova (PID ${firstTray} → ${trayPid()})`);
ok(await wait(() => { try { process.kill(firstPid!, 0); return false; } catch { return true; } }, 30_000), 'il vecchio processo è chiuso');

const { withoutConsole } = await import('../src/pe.js');
ok(sha(fs.readFileSync(path.join(bin, 'ciccio-companion.exe'))) === sha(nextBytes), 'copia con console sostituita');
ok(sha(fs.readFileSync(path.join(bin, 'ciccio-companion-background.exe'))) === sha(withoutConsole(nextBytes)), 'copia in background sostituita (senza console)');
ok(await wait(() => !fs.readdirSync(bin).some((f) => f.endsWith('.old')), 30_000), `nessuna copia .old rimasta (${fs.readdirSync(bin).join(', ')})`);
const runCmd = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'CiccioCompanion'], { encoding: 'utf8' });
ok(runCmd.includes(path.join(bin, 'ciccio-companion-background.exe')), 'avvio automatico invariato');

// Con la versione già aggiornata Ciccio non offre più niente: niente secondo giro.
await new Promise((r) => setTimeout(r, 5000));
ok(pidNow() === newPid, 'nessun secondo aggiornamento');
ok(/"version":"9\.9\.9"/.test(fs.readFileSync(path.join(home, 'tray-state.json'), 'utf8')), 'l\'icona nuova è alla 9.9.9');

const un = await run(path.join(bin, 'ciccio-companion.exe'), ['uninstall'], { env });
console.log(un.stdout.trim());
await app.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows: file ancora aperti, li toglie il runner */ }
console.log(failed ? '\nPROVA FALLITA' : '\nPROVA RIUSCITA');
process.exit(failed ? 1 : 0);
