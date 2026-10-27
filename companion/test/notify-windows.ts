// Prova delle notifiche di Ciccio e dei permessi su Windows (CI "Companion Windows"):
// registrazione (AppUserModelID e collegamento nel menu Start), guida ai permessi al primo avvio,
// controlli dei permessi, avviso di Ciccio → companion → file → notifica di Windows, notifiche vecchie
// scartate, «Notifiche di Ciccio» spente e riaccese senza toccare il resto della config, pulizia.
//
//   pnpm exec tsx companion/test/notify-windows.ts dist\companion\ciccio-companion-windows-x64.exe

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'win32') { console.log('Prova solo per Windows.'); process.exit(0); }
const exe = path.resolve(process.argv[2] ?? '');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-notify-'));
process.env.CICCIO_DATA_DIR = path.join(tmp, 'data');
const home = path.join(tmp, 'companion home');
const env = { ...process.env, CICCIO_COMPANION_HOME: home };
const cfgPath = path.join(home, 'config.json');
const notifyDir = path.join(home, 'notify');
const run = promisify(execFile);
const AUMID = 'it.costa.ciccio-companion';
const lnk = path.join(process.env.APPDATA!, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Ciccio Companion.lnk');

const { default: Fastify } = await import('fastify');
const { default: websocket } = await import('@fastify/websocket');
const { registerCompanion, companions } = await import('../../server/src/companion.js');
const { bus } = await import('../../server/src/bus.js');

let failed = false;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failed = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (f: () => boolean, ms: number) => {
  for (const t0 = Date.now(); !f(); ) { if (Date.now() - t0 > ms) return false; await sleep(300); }
  return true;
};
const log = () => { try { return fs.readFileSync(path.join(home, 'companion.log'), 'utf8'); } catch { return ''; } };
const ps = (cmd: string) => execFileSync('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(`$ProgressPreference = 'SilentlyContinue'; ${cmd}`, 'utf16le').toString('base64')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const countProcs = (like: string) => Number(ps(`@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.ProcessId -ne $PID }).Count`)) || 0;
const pending = () => { try { return fs.readdirSync(notifyDir).filter((f) => f.endsWith('.json')); } catch { return []; } };
const view = () => companions().find((c) => c.name === 'avvisi');

const app = Fastify();
await app.register(websocket);
registerCompanion(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const port = (app.server.address() as { port: number }).port;
const { token } = (await app.inject({ method: 'POST', url: '/api/companions', payload: { name: 'avvisi' } })).json() as { token: string };

await run(exe, ['init', token, '--server', `http://127.0.0.1:${port}`, '--config', cfgPath], { env });
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.mcpServers = { finto: { command: 'cmd', args: ['/c', 'exit', '1'], disabled: true } };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log((await run(exe, ['install', '--config', cfgPath], { env })).stdout.trim());

// ── Registrazione per le notifiche ────────────────────────────────────────
ok(fs.existsSync(lnk), `collegamento nel menu Start (${lnk})`);
const aumidKey = ps(`(Get-ItemProperty 'HKCU:\\Software\\Classes\\AppUserModelId\\${AUMID}').DisplayName`);
ok(aumidKey === 'Ciccio Companion', `AppUserModelID registrato (DisplayName: ${aumidKey})`);
// L'AppUserModelID letto dal collegamento stesso (l'indice del menu Start si aggiorna quando vuole lui).
const lnkAumid = ps(`$f = Get-Item -LiteralPath '${lnk.replace(/'/g, "''")}'; (New-Object -ComObject Shell.Application).NameSpace($f.DirectoryName).ParseName($f.Name).ExtendedProperty('System.AppUserModel.ID')`);
ok(lnkAumid === AUMID, `il collegamento porta l'AppUserModelID (${lnkAumid})`);

// ── Primo avvio: prima la guida ai permessi ───────────────────────────────
ok(await wait(() => countProcs('permissions.ps1') > 0, 30_000), 'al primo avvio si apre «Permessi di Ciccio Companion»');
ok(/icona · finestra dei permessi/.test(log()), 'registro: finestra dei permessi');
ps(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*permissions.ps1*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);

const checks = JSON.parse((await run(exe, ['permissions', '--json', '--config', cfgPath], { env })).stdout) as { key: string; ok: boolean | null; text: string; state?: string; button?: { action: string } | null }[];
for (const c of checks) console.log(`  ${c.key}: ${c.ok} · ${c.text}${c.state ? ` [${c.state}]` : ''}${c.button ? ` → ${c.button.action}` : ''}`);
const byKey = (k: string) => checks.find((c) => c.key === k);
ok(byKey('notifications')?.state === 'Enabled' && byKey('notifications')?.ok === true, `notifiche accese per Ciccio Companion (${byKey('notifications')?.state})`);

// Spente per l'app in Impostazioni › Notifiche (stesso valore che scrive Windows): la guida se ne accorge.
const appKey = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${AUMID}`;
ps(`New-Item -Force '${appKey}' | Out-Null; Set-ItemProperty '${appKey}' -Name Enabled -Type DWord -Value 0`);
const muted = JSON.parse((await run(exe, ['permissions', '--json', '--config', cfgPath], { env })).stdout) as { key: string; ok: boolean | null; state?: string }[];
const mutedN = muted.find((c) => c.key === 'notifications');
ok(mutedN?.ok === false, `notifiche spente per l'app riconosciute (${mutedN?.state})`);
ps(`Remove-Item -Recurse -Force '${appKey}' -ErrorAction SilentlyContinue`);
ok(byKey('notifications')?.button?.action === 'ms-settings:notifications', 'pulsante verso Impostazioni › Notifiche');
ok(byKey('startup')?.ok === true && byKey('startup')?.button?.action === 'ms-settings:startupapps', 'avvio all\'accesso attivo, pulsante verso Impostazioni › App › Avvio');
ok(byKey('dnd')?.button?.action.startsWith('ms-settings:'), 'promemoria Non disturbare');

// Spento in Impostazioni › App › Avvio (come fa Windows): la guida se ne accorge.
ps(`New-Item -Force 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' | Out-Null; Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' -Name CiccioCompanion -Type Binary -Value ([byte[]](3,0,0,0,0,0,0,0,0,0,0,0))`);
const off = JSON.parse((await run(exe, ['permissions', '--json', '--config', cfgPath], { env })).stdout) as { key: string; ok: boolean | null }[];
ok(off.find((c) => c.key === 'startup')?.ok === false, 'avvio spento in Impostazioni riconosciuto');
ps(`Remove-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' -Name CiccioCompanion -ErrorAction SilentlyContinue`);

// ── Avviso di Ciccio → notifica di Windows ────────────────────────────────
ok(await wait(() => !!view()?.online && view()?.notifications === true, 60_000), 'Ciccio sa che questo PC mostra le notifiche');
bus.emit({ type: 'message', message: {
  id: 4242, chatId: 'c1', agentId: 'demo', role: 'agent', text: 'Ha finito il giro e aspetta una tua risposta.', ts: Date.now(),
  meta: { kind: 'notice', agentId: 'demo', chatId: 'c1', chatTitle: 'Prova', tone: 'wait' },
} });
const arrived = await wait(() => /notifica (mostrata|non mostrata) \(4242[,)]/.test(log()), 45_000);
ok(arrived, 'avviso arrivato all\'icona');
if (!arrived) console.log(`--- registro ---\n${log()}\n--- interfaccia: ${countProcs('tray-ui.ps1')} processi ---`);
const line = /icona · notifica (mostrata|non mostrata) \(4242[,)].*/.exec(log())?.[0] ?? '';
console.log(`  ${line}`);
ok(/notifica mostrata \(4242[,)]/.test(line), 'notifica di Windows creata senza errori');
ok(pending().length === 0, 'file della notifica consumato');

fs.mkdirSync(notifyDir, { recursive: true });
fs.writeFileSync(path.join(notifyDir, `${Date.now() - 11 * 60_000}-vecchia.json`), JSON.stringify({ id: 'vecchia', title: 't', body: 'b', url: 'https://ciccio.example.com/' }));
ok(await wait(() => pending().length === 0, 10_000), 'notifica di più di 10 minuti fa scartata');
await sleep(1500);
ok(!/\(vecchia\)/.test(log()), 'e non mostrata');

// ── «Notifiche di Ciccio» spente e riaccese ───────────────────────────────
await run(exe, ['notifications', 'off', '--config', cfgPath], { env });
const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
ok(after.notifications === false && after.token === token && after.mcpServers?.finto?.disabled === true, 'config: solo «notifications» cambiato');
ok(await wait(() => !!view()?.online && view()?.notifications === false, 60_000), 'spente: Ciccio non le manda più a questo PC');
await run(exe, ['notifications', 'on', '--config', cfgPath], { env });
ok(await wait(() => !!view()?.online && view()?.notifications === true, 60_000), 'riaccese');

// ── Pulizia ──────────────────────────────────────────────────────────────
await run(path.join(home, 'bin', 'ciccio-companion.exe'), ['uninstall'], { env });
ok(!fs.existsSync(lnk), 'uninstall toglie il collegamento nel menu Start');
let gone = false;
try { ps(`Get-Item 'HKCU:\\Software\\Classes\\AppUserModelId\\${AUMID}' -ErrorAction Stop | Out-Null`); } catch { gone = true; }
ok(gone, 'e la registrazione dell\'AppUserModelID');
await app.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* file ancora aperti: li toglie il runner */ }
console.log(failed ? '\nPROVA FALLITA' : '\nPROVA RIUSCITA');
process.exit(failed ? 1 : 0);
