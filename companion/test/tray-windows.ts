// Prova dell'icona nell'area di notifica su Windows (CI "Companion Windows"), come l'app del Mac:
// parte con install, tiene acceso il companion, mostra lo stato da status.json, «Ricollega» non si
// blocca (nemmeno con il companion congelato), riaccende il companion se muore, "stop" chiude tutto,
// e un'installazione vecchia (avvio senza icona) passa all'icona da sola.
//
//   pnpm exec tsx companion/test/tray-windows.ts dist\companion\ciccio-companion-windows-x64.exe

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'win32') { console.log('Prova solo per Windows.'); process.exit(0); }
const exe = path.resolve(process.argv[2] ?? '');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-tray-'));
process.env.CICCIO_DATA_DIR = path.join(tmp, 'data');
const home = path.join(tmp, 'companion home');
const env = { ...process.env, CICCIO_COMPANION_HOME: home };
const cfgPath = path.join(home, 'config.json');
const bg = path.join(home, 'bin', 'ciccio-companion-background.exe');
const run = promisify(execFile);

const { default: Fastify } = await import('fastify');
const { default: websocket } = await import('@fastify/websocket');
const { registerCompanion, companions } = await import('../../server/src/companion.js');

let failed = false;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failed = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (f: () => boolean, ms: number) => {
  for (const t0 = Date.now(); !f(); ) { if (Date.now() - t0 > ms) return false; await sleep(300); }
  return true;
};
const read = (f: string) => { try { return fs.readFileSync(path.join(home, f), 'utf8'); } catch { return ''; } };
const pid = (f: string) => Number(read(f).trim()) || null;
const isAlive = (p: number | null) => { if (!p) return false; try { process.kill(p, 0); return true; } catch { return false; } };
const trayState = () => { try { return JSON.parse(read('tray-state.json')) as { on: boolean; tooltip: string; menu: { text?: string; checked?: boolean }[]; childPid: number | null; ui: boolean; updatedAt: number }; } catch { return null; } };
const menuText = () => (trayState()?.menu ?? []).map((m) => m.text ?? '—').join(' | ');
// -EncodedCommand: niente problemi di virgolette tra Node e PowerShell.
const ps = (cmd: string) => execFileSync('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(`$ProgressPreference = 'SilentlyContinue'; ${cmd}`, 'utf16le').toString('base64')], { encoding: 'utf8' }).trim();
const countProcs = (like: string) => Number(ps(`@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.ProcessId -ne $PID }).Count`)) || 0;

const app = Fastify();
await app.register(websocket);
registerCompanion(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const port = (app.server.address() as { port: number }).port;
const { token } = (await app.inject({ method: 'POST', url: '/api/companions', payload: { name: 'vassoio' } })).json() as { token: string };

await run(exe, ['init', token, '--server', `http://127.0.0.1:${port}`, '--config', cfgPath], { env });
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.mcpServers = { everything: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything@2026.8.31', 'stdio'] } };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

// ── Avvio ────────────────────────────────────────────────────────────────
const inst = await run(exe, ['install', '--config', cfgPath], { env });
console.log(inst.stdout.trim());
ok(/icona nell'area di notifica/.test(inst.stdout), 'install accende l\'icona');
const trayPid = pid('tray.pid');
ok(isAlive(trayPid), `icona accesa (PID ${trayPid})`);
ok(await wait(() => isAlive(pid('companion.pid')), 20_000), 'l\'icona accende il companion');
ok(await wait(() => !!companions().find((c) => c.name === 'vassoio' && c.online && c.servers.some((s) => s.status === 'online')), 120_000), 'collegato a Ciccio con il server "everything"');
ok(await wait(() => trayState()?.on === true, 10_000), 'icona piena quando è collegato');
ok(trayState()?.tooltip === 'Ciccio Companion · collegato', `suggerimento: ${trayState()?.tooltip}`);
ok(await wait(() => /● Collegato come «vassoio»/.test(menuText()) && /everything: \d+ strumenti/.test(menuText()), 10_000), `menu: ${menuText()}`);
ok(/Apri Ciccio \| Ricollega \| Avvia all'accesso \| Notifiche di Ciccio \| Permessi…( \(\d+ da attivare\))? \| Strumenti esposti… \| Registro \| — \| Esci$/.test(menuText()), 'voci del menu come sul Mac');
ok(trayState()?.menu.find((m) => m.text === "Avvia all'accesso")?.checked === true, '«Avvia all\'accesso» spuntato');
ok(await wait(() => countProcs('tray-ui.ps1') > 0, 15_000), 'interfaccia PowerShell dell\'icona accesa');
ok(await wait(() => /icona · nell'area di notifica/.test(read('companion.log')), 30_000), 'icona creata nell\'area di notifica (Windows Forms)');
console.log(read('companion.log').split('\n').filter((l) => l.includes('icona')).join('\n'));

// ── Ricollega ────────────────────────────────────────────────────────────
const before = pid('companion.pid');
await run(exe, ['reconnect'], { env });
const t0 = trayState()!.updatedAt;
ok(await wait(() => isAlive(pid('companion.pid')) && pid('companion.pid') !== before, 20_000), `Ricollega: companion ripartito (PID ${before} → ${pid('companion.pid')})`);
ok((trayState()?.updatedAt ?? 0) > t0, 'l\'icona ha continuato ad aggiornarsi durante «Ricollega»');
ok(await wait(() => trayState()?.on === true, 60_000), 'di nuovo collegato dopo «Ricollega»');

// ── Ricollega con il companion congelato: dopo 5 s si chiude a forza ──────
const frozen = pid('companion.pid')!;
ps(`Add-Type -Name N -Namespace W -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);'; $p = Get-Process -Id ${frozen}; [void][W.N]::NtSuspendProcess($p.Handle)`);
const t1 = Date.now();
await run(exe, ['reconnect'], { env });
await sleep(3000);
ok((trayState()?.updatedAt ?? 0) > t1, 'icona viva con il companion congelato');
ok(await wait(() => !isAlive(frozen), 15_000), `companion congelato chiuso a forza dopo ${((Date.now() - t1) / 1000).toFixed(0)} s`);
ok(await wait(() => isAlive(pid('companion.pid')) && pid('companion.pid') !== frozen, 20_000), 'e riacceso');

// ── Il companion muore: l'icona lo riaccende da sola ───────────────────────
const victim = pid('companion.pid')!;
// Crash simulato (con i figli). taskkill /T risponde errore se un figlio esce mentre chiude l'albero: conta che sia morto.
try { execFileSync('taskkill', ['/PID', String(victim), '/T', '/F'], { stdio: 'ignore' }); } catch { /* vedi sotto */ }
ok(await wait(() => !isAlive(victim), 10_000), `companion ucciso (PID ${victim})`);
ok(await wait(() => isAlive(pid('companion.pid')) && pid('companion.pid') !== victim, 20_000), 'companion morto riacceso dall\'icona');
ok(await wait(() => trayState()?.on === true, 60_000), 'di nuovo collegato');

// ── Esci (stop): chiude icona, interfaccia, companion e server MCP figli ──
const st = await run(exe, ['status'], { env });
ok(/Icona nell'area di notifica: accesa/.test(st.stdout), 'status vede l\'icona');
await run(exe, ['stop'], { env });
ok(await wait(() => !isAlive(trayPid) && !isAlive(pid('companion.pid')), 20_000), 'stop chiude icona e companion');
ok(await wait(() => countProcs('tray-ui.ps1') === 0 && countProcs('server-everything') === 0, 15_000), 'nessun processo rimasto (interfaccia, server MCP)');
ok(await wait(() => !companions()[0].online, 10_000), 'Ciccio lo vede spento');

// ── Installazione della 0.3.0 (avvio senza icona): passa all'icona da sola ──
const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
execFileSync('reg', ['add', runKey, '/v', 'CiccioCompanion', '/t', 'REG_SZ', '/d', `"${bg}" run --background --config "${cfgPath}"`, '/f'], { stdio: 'ignore' });
spawn(bg, ['run', '--background', '--config', cfgPath], { env, detached: true, stdio: 'ignore' }).unref();
ok(await wait(() => isAlive(pid('tray.pid')), 20_000), 'vecchio avvio automatico: si accende l\'icona');
const newCmd = execFileSync('reg', ['query', runKey, '/v', 'CiccioCompanion'], { encoding: 'utf8' });
ok(/ tray --config /.test(newCmd), 'chiave Run aggiornata all\'icona');
ok(await wait(() => companions()[0].online, 120_000), 'collegato di nuovo, tramite l\'icona');

await run(path.join(home, 'bin', 'ciccio-companion.exe'), ['uninstall'], { env });
ok(await wait(() => !isAlive(pid('tray.pid')) && countProcs('tray-ui.ps1') === 0, 20_000), 'uninstall chiude tutto');
await app.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* file ancora aperti: li toglie il runner */ }
console.log(failed ? '\nPROVA FALLITA' : '\nPROVA RIUSCITA');
process.exit(failed ? 1 : 0);
