import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { configDir } from './config.js';

// Un solo processo per ruolo e per utente:
// - "companion": quello collegato a Ciccio (in background, nella finestra, o figlio dell'icona);
// - "tray": l'icona nell'area di notifica di Windows, che tiene acceso il companion.
// Ognuno scrive il suo PID; "ciccio-companion stop" chiede di chiudersi con un file, così si chiudono
// bene anche i server MCP figli (su Windows terminare il processo da fuori lascerebbe orfani npx e Chrome).

export type Role = 'companion' | 'tray';

const NAMES: Record<Role, { pid: string; stop: string; handoff: string }> = {
  companion: { pid: 'companion.pid', stop: 'companion.stop', handoff: 'handoff.json' },
  tray: { pid: 'tray.pid', stop: 'tray.stop', handoff: 'tray-handoff.json' },
};

export const pidFile = (role: Role = 'companion') => path.join(configDir(), NAMES[role].pid);
const stopFile = (role: Role) => path.join(configDir(), NAMES[role].stop);
const handoffFile = (role: Role) => path.join(configDir(), NAMES[role].handoff);
export const logFile = () => path.join(configDir(), 'companion.log');

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PID del processo acceso con quel ruolo (non questo), se c'è. */
export function runningPid(role: Role = 'companion'): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFile(role), 'utf8').trim());
    return pid > 0 && pid !== process.pid && alive(pid) ? pid : null;
  } catch { return null; }
}

/** Segna il PID e controlla ogni 2 s se gli si chiede di chiudersi. */
export function claimInstance(onStop: () => void, role: Role = 'companion') {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.rmSync(stopFile(role), { force: true });
  fs.writeFileSync(pidFile(role), String(process.pid), { mode: 0o600 });
  const timer = setInterval(() => {
    if (fs.existsSync(stopFile(role))) { clearInterval(timer); onStop(); }
  }, role === 'tray' ? 1000 : 2000);
  timer.unref();
}

export function releaseInstance(role: Role = 'companion') {
  try { if (Number(fs.readFileSync(pidFile(role), 'utf8').trim()) === process.pid) fs.rmSync(pidFile(role), { force: true }); } catch { /* già tolto */ }
  fs.rmSync(stopFile(role), { force: true });
}

/** Chiude a forza un processo e i suoi figli (Windows: taskkill /T), senza aspettare. */
export function killTree(pid: number) {
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* già chiuso */ } }
}

/** Chiede di chiudersi al processo con quel ruolo; dopo `ms` lo chiude a forza. */
export async function stopRole(role: Role, ms = 15_000): Promise<boolean> {
  const pid = runningPid(role);
  if (!pid) return false;
  requestStop(role);
  for (let t = 0; t < ms && alive(pid); t += 250) await sleep(250);
  if (alive(pid)) { killTree(pid); for (let i = 0; i < 20 && alive(pid); i++) await sleep(250); }
  fs.rmSync(stopFile(role), { force: true });
  fs.rmSync(pidFile(role), { force: true });
  return true;
}

/** "stop": prima l'icona (che altrimenti lo riaccenderebbe), poi il companion. */
export async function stopRunning(): Promise<boolean> {
  const tray = await stopRole('tray');
  const companion = await stopRole('companion');
  return tray || companion;
}

/** Chiede al processo con quel ruolo (anche a se stesso) di chiudersi bene, con il file di stop. */
export function requestStop(role: Role = 'companion') {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(stopFile(role), String(Date.now()));
}

// ── Passaggio di consegne dopo un aggiornamento (Windows) ───────────────
// Il processo nuovo parte con --replaces <pid del vecchio>: scrive subito il suo handoff (così il vecchio
// sa che è partito davvero), poi aspetta che il vecchio si chiuda prima di prendere il suo posto.

export function writeHandoff(version: string, role: Role = 'companion') {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(handoffFile(role), JSON.stringify({ pid: process.pid, version }), { mode: 0o600 });
}

/** Aspetta che il processo nuovo dica di essere partito con quella versione. */
export async function waitHandoff(version: string, ms: number, role: Role = 'companion'): Promise<number | null> {
  for (let t = 0; t < ms; t += 250) {
    try {
      const h = JSON.parse(fs.readFileSync(handoffFile(role), 'utf8')) as { pid?: number; version?: string };
      if (h.version === version && h.pid && alive(h.pid)) return h.pid;
    } catch { /* non ancora scritto */ }
    await sleep(250);
  }
  return null;
}

export function clearHandoff(role: Role = 'companion') {
  fs.rmSync(handoffFile(role), { force: true });
}

/** Il nuovo aspetta che il vecchio si chiuda (lo chiude a forza dopo 60 s, con i figli). */
export async function waitExit(pid: number) {
  for (let i = 0; i < 240 && alive(pid); i++) await sleep(250);
  if (!alive(pid)) return;
  killTree(pid);
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
}
