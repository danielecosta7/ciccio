import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { OP_REF, type OnePasswordFeatures } from '../../shared/companion.js';

// 1Password sul PC, per gli agenti di Ciccio:
// - agent SSH: Ciccio gira qui i messaggi ssh-agent (elenco chiavi, firma); la chiave privata resta in 1Password,
//   che chiede l'autorizzazione con Touch ID / Windows Hello.
// - CLI op: legge un segreto quando l'utente l'ha approvato in Ciccio; 1Password chiede di nuovo Touch ID.

/** Socket (Mac, Linux) o named pipe (Windows) dell'agent SSH di 1Password. */
export function sshAgentPath(): string {
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Group Containers', '2BUA8C4S2C.com.1password', 't', 'agent.sock');
  return path.join(os.homedir(), '.1password', 'agent.sock');
}

// Su Windows la named pipe di 1Password risponde a stat con EBUSY (esiste, ma è aperta dall'agent):
// va contata come presente, altrimenti le chiavi SSH risultano sempre «non disponibili».
const exists = (p: string) => {
  // Named pipe di Windows: si guarda l'elenco di \\.\pipe\ (non dipende da come il runtime tratta stat sulle pipe).
  if (process.platform === 'win32' && p.startsWith('\\\\.\\pipe\\')) {
    try { if (fs.readdirSync('\\\\.\\pipe\\').some((n) => n.toLowerCase() === p.slice(9).toLowerCase())) return true; } catch { /* si prova con stat */ }
  }
  try { fs.statSync(p); return true; } catch (e) { return ['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? ''); }
};

/** La CLI op: nei posti dove la mettono Homebrew, l'installer e winget (l'app parte senza il PATH della shell). */
function findOp(): string | null {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'op.exe'),
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', '1Password CLI', 'op.exe'),
        ...(process.env.PATH ?? '').split(';').filter(Boolean).map((d) => path.join(d, 'op.exe')),
      ]
    : ['/opt/homebrew/bin/op', '/usr/local/bin/op', '/usr/bin/op', ...(process.env.PATH ?? '').split(':').filter(Boolean).map((d) => path.join(d, 'op'))];
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) ?? null;
}

export function onePasswordFeatures(): OnePasswordFeatures {
  return { sshAgent: exists(sshAgentPath()), cli: !!findOp() };
}

// Solo questi messaggi arrivano all'agent: elenco chiavi (11) e firma (13). Aggiungere o togliere chiavi,
// bloccare l'agent e le estensioni restano fuori, anche se Ciccio li mandasse.
const REQUEST_IDENTITIES = 11;
const SIGN_REQUEST = 13;
const MAX_MESSAGE = 256 * 1024;

/** Un messaggio ssh-agent (con la lunghezza davanti) all'agent di 1Password, e la sua risposta intera. */
export function sshAgentRequest(message: Buffer, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (message.length < 5 || message.length > MAX_MESSAGE || message.readUInt32BE(0) !== message.length - 4) { reject(new Error('messaggio ssh-agent non valido')); return; }
    const type = message[4];
    if (type !== REQUEST_IDENTITIES && type !== SIGN_REQUEST) { reject(new Error(`messaggio ssh-agent ${type} non consentito`)); return; }
    const sock = net.connect(sshAgentPath());
    let buf = Buffer.alloc(0);
    // La firma aspetta Touch ID: fino a due minuti.
    const timer = setTimeout(() => finish(new Error('1Password non ha risposto entro 2 minuti')), 120_000);
    const onAbort = () => finish(new Error('richiesta annullata'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (err: Error | null, out?: Buffer) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      sock.destroy();
      if (err) reject(err); else resolve(out!);
    };
    sock.on('connect', () => sock.write(message));
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len > MAX_MESSAGE) finish(new Error('risposta ssh-agent troppo grande'));
        else if (buf.length >= 4 + len) finish(null, buf.subarray(0, 4 + len));
      }
    });
    sock.on('error', (e) => finish(new Error(`agent SSH di 1Password non raggiungibile: ${e.message}`)));
    sock.on('close', () => finish(new Error('l\'agent SSH di 1Password ha chiuso senza rispondere')));
  });
}

/** op read: il valore di un campo di 1Password. Touch ID lo chiede 1Password. */
export function readSecret(ref: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof ref !== 'string' || !OP_REF.test(ref) || ref.length > 400) { reject(new Error('riferimento non valido: serve op://vault/elemento/campo')); return; }
    const op = findOp();
    if (!op) { reject(new Error('CLI di 1Password (op) non installata su questo PC')); return; }
    execFile(op, ['read', '--no-newline', ref], { timeout: 120_000, maxBuffer: 1024 * 1024, signal, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message).replace(/\s+/g, ' ').trim().slice(0, 300);
        reject(new Error(/not currently signed in|authorization|authenticat|cancel/i.test(msg) ? `1Password non ha autorizzato la lettura (${msg})` : msg || 'op read non riuscito'));
        return;
      }
      resolve(stdout);
    });
  });
}
