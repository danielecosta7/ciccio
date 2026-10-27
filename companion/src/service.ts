import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { configDir } from './config.js';
import { logFile, runningPid, stopRunning, type Role } from './instance.js';
import { withoutConsole } from './pe.js';
import { registerApp, unregisterApp } from './windows-ui.js';

// Avvio automatico all'accesso, senza finestre e senza diritti di amministratore:
// - Mac: LaunchAgent dell'utente (l'app della barra dei menu ha il suo);
// - Windows: l'icona nell'area di notifica (tray.ts), cioè una copia "senza console" dell'.exe in
//   %USERPROFILE%\.ciccio-companion\bin avviata con "tray" dalla chiave Run dell'utente (HKCU); l'icona tiene
//   acceso il companion. Le attività pianificate all'accesso chiederebbero l'amministratore.
// Il companion gira con --background e scrive in ~/.ciccio-companion/companion.log.
// Su Windows c'è anche il link ciccio-companion:// (HKCU\Software\Classes) per collegarsi con un clic.

const LABEL = 'it.costa.ciccio-companion';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'CiccioCompanion';
const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\ciccio-companion';
/** Interruttore di Impostazioni › App › Avvio: spegne la voce della chiave Run senza toglierla. */
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
/** Nome dell'attività pianificata delle prime versioni: si toglie se c'è. */
const OLD_TASK = 'Ciccio Companion';

export const backgroundExe = () => path.join(configDir(), 'bin', 'ciccio-companion-background.exe');
/** Copia "con console" usata dal link ciccio-companion:// (mostra la domanda di conferma). */
export const consoleExe = () => path.join(configDir(), 'bin', 'ciccio-companion.exe');
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const quiet = { stdio: 'ignore' as const, windowsHide: true };

function binary(): string {
  const exe = process.execPath;
  // Da sorgente (node/bun/tsx) non c'è un binario stabile da avviare.
  if (/^(node|bun)(\.exe)?$/i.test(path.basename(exe))) {
    throw new Error("L'avvio automatico si installa dal binario compilato (pnpm companion:build), non da sorgente.");
  }
  return exe;
}

async function waitRunning(ms: number, role: Role = 'companion'): Promise<number | null> {
  for (let t = 0; t < ms; t += 250) {
    const pid = runningPid(role);
    if (pid) return pid;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export async function install(configPath: string): Promise<string> {
  const exe = binary();
  if (process.platform === 'darwin') {
    // launchd parte con un PATH minimo: si porta quello di adesso, così npx e node si trovano.
    const errLog = path.join(os.homedir(), 'Library', 'Logs', 'ciccio-companion.log');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(exe)}</string><string>run</string><string>--background</string><string>--config</string><string>${xml(configPath)}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(errLog)}</string>
  <key>StandardErrorPath</key><string>${xml(errLog)}</string>
</dict>
</plist>
`;
    const uid = os.userInfo().uid;
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], quiet); } catch { /* non era attivo */ }
    await stopRunning();
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), plist);
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath()]);
    const pid = await waitRunning(5000);
    return `Avvio automatico attivo (LaunchAgent ${LABEL})${pid ? `, acceso adesso (PID ${pid})` : ''}.\nRegistro: ${logFile()}`;
  }
  if (process.platform === 'win32') {
    // Icona e companion in background tengono aperti i loro .exe: vanno chiusi prima di sostituirli.
    await stopRunning();
    windowsCopies(exe);
    setLoginItem(true, configPath);
    // Nome e icona per le notifiche e collegamento nel menu Start (AppUserModelID).
    const reg = await registerApp(backgroundExe(), path.dirname(backgroundExe()));
    if (!reg.ok) console.log(`Registrazione per le notifiche non riuscita: ${reg.error}`);
    try { execFileSync('schtasks', ['/Delete', '/F', '/TN', OLD_TASK], quiet); } catch { /* non c'era */ }
    // Parte subito, senza aspettare il prossimo accesso.
    startTray(configPath);
    const pid = await waitRunning(10_000, 'tray');
    return pid
      ? `Ciccio Companion è acceso: icona nell'area di notifica (PID ${pid}), riparte da solo a ogni accesso a Windows.\nRegistro: ${logFile()}`
      : `Avvio automatico attivo, ma l'icona non è partita: guarda il registro (${logFile()}).`;
  }
  throw new Error('Avvio automatico disponibile solo su Mac e Windows.');
}

/**
 * Windows: copia l'.exe in %USERPROFILE%\.ciccio-companion\bin (una con console per il link di
 * abbinamento, una senza per il background) e registra il link ciccio-companion://.
 * Così l'.exe scaricato si può anche cancellare.
 */
export function windowsCopies(exe = binary()) {
  const bin = path.dirname(backgroundExe());
  fs.mkdirSync(bin, { recursive: true });
  const self = fs.readFileSync(exe);
  const same = (p: string) => path.resolve(exe).toLowerCase() === path.resolve(p).toLowerCase();
  if (!same(consoleExe())) fs.writeFileSync(consoleExe(), self);
  if (!same(backgroundExe())) fs.writeFileSync(backgroundExe(), withoutConsole(self));
  const reg = (args: string[]) => execFileSync('reg', ['add', ...args, '/f'], quiet);
  reg([PROTOCOL_KEY, '/ve', '/d', 'URL:Ciccio Companion']);
  reg([PROTOCOL_KEY, '/v', 'URL Protocol', '/d', '']);
  reg([`${PROTOCOL_KEY}\\DefaultIcon`, '/ve', '/d', `"${consoleExe()}",0`]);
  // Il link apre la copia senza console: le domande arrivano in una finestra vera, come sul Mac.
  reg([`${PROTOCOL_KEY}\\shell\\open\\command`, '/ve', '/d', `"${backgroundExe()}" pair "%1"`]);
}

/** Comando dell'avvio automatico: l'icona, che tiene acceso il companion. */
export const trayCommand = (configPath: string) => `"${backgroundExe()}" tray --config "${configPath}"`;

/** Accende o spegne l'avvio all'accesso a Windows (chiave Run dell'utente). */
export function setLoginItem(on: boolean, configPath: string) {
  if (on) {
    execFileSync('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', trayCommand(configPath), '/f'], quiet);
    // Accenderlo dal menu è una scelta esplicita: vale anche se era stato spento in Impostazioni › App › Avvio.
    try { execFileSync('reg', ['delete', APPROVED_KEY, '/v', RUN_VALUE, '/f'], quiet); } catch { /* non era spento */ }
  } else { try { execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], quiet); } catch { /* non c'era */ } }
}

/** Comando nella chiave Run, se c'è (le versioni fino alla 0.3.0 avviavano "run --background"). */
export function loginCommand(): string | null {
  try {
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return /REG_SZ\s+(.+)$/m.exec(out)?.[1].trim() ?? null;
  } catch { return null; }
}

/** Spento in Impostazioni › App › Avvio? (primo byte dispari nel valore di StartupApproved\Run) */
export function startupDisabled(): boolean {
  try {
    const out = execFileSync('reg', ['query', APPROVED_KEY, '/v', RUN_VALUE], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const hex = /REG_BINARY\s+([0-9A-Fa-f]{2})/.exec(out)?.[1];
    return hex != null && (Number.parseInt(hex, 16) & 1) === 1;
  } catch { return false; }
}

/** Avvia l'icona (copia senza console), staccata da chi la lancia. */
export function startTray(configPath: string, extra: string[] = []) {
  spawn(backgroundExe(), ['tray', '--config', configPath, ...extra], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export async function uninstall(): Promise<string> {
  if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${os.userInfo().uid}/${LABEL}`], quiet); } catch { /* non era attivo */ }
    fs.rmSync(plistPath(), { force: true });
    await stopRunning();
    return 'Avvio automatico tolto e companion in background chiuso.';
  }
  if (process.platform === 'win32') {
    try { execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], quiet); } catch { /* non c'era */ }
    try { execFileSync('reg', ['delete', PROTOCOL_KEY, '/f'], quiet); } catch { /* non c'era */ }
    await unregisterApp();
    try { execFileSync('schtasks', ['/Delete', '/F', '/TN', OLD_TASK], quiet); } catch { /* non c'era */ }
    await stopRunning();
    // La copia con console può essere quella che sta girando adesso: in quel caso resta, è innocua.
    const bin = path.dirname(backgroundExe());
    for (const f of [backgroundExe(), consoleExe(), path.join(bin, 'ciccio.ico'), path.join(bin, 'ciccio.png')]) { try { fs.rmSync(f, { force: true }); } catch { /* in uso */ } }
    return 'Avvio automatico e link di abbinamento tolti, companion in background chiuso. La config resta in ' + configDir() + '.';
  }
  throw new Error('Avvio automatico disponibile solo su Mac e Windows.');
}

/** L'avvio automatico è installato? */
export function installed(): boolean {
  if (process.platform === 'darwin') return fs.existsSync(plistPath());
  if (process.platform === 'win32') {
    try { execFileSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE], quiet); return true; } catch { return false; }
  }
  return false;
}
