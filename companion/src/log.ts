import fs from 'node:fs';

// Stato del companion: una riga per evento, con l'ora. Nel terminale, oppure in un file quando
// gira in background (avvio automatico, nessuna finestra): ciccio-companion status lo mostra.

const MAX_LOG_BYTES = 2 * 1024 * 1024;

let logFile: string | null = null;

/** Colori ANSI solo in un terminale che li supporta (Windows Terminal, PowerShell, cmd recenti, Terminale del Mac). */
const colors = (): boolean =>
  !logFile && !process.env.NO_COLOR && !!process.stdout.isTTY && (process.stdout.hasColors?.() ?? true);

const paint = (code: string) => (s: string) => (colors() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = paint('32');
export const red = paint('31');
export const yellow = paint('33');
export const dim = paint('2');

/** Da qui in poi le righe vanno nel file (un solo file precedente tenuto: companion.log.1). */
export function logToFile(file: string) {
  logFile = file;
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* file non ancora creato */ }
}

function write(line: string) {
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${line}\n`, { mode: 0o600 });
      if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
    } catch { /* il registro non deve fermare il companion */ }
    return;
  }
  console.log(line);
}

export function log(msg: string) {
  const now = new Date();
  const t = now.toLocaleTimeString('it-IT', { hour12: false });
  // Nel file serve anche la data: il companion resta acceso per giorni.
  write(logFile ? `${now.toLocaleDateString('it-IT')} ${t} ${msg}` : `${dim(t)} ${msg}`);
}
