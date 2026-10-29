import fs from 'node:fs';
import net from 'node:net';
import { parseBridgeTarget } from '../../shared/companion.js';
import { openBridgeOnPc } from './companion.js';
import { chatSocketPath } from './sshAgent.js';

// Ponte SSH per le sessioni degli agenti: ogni chat al lavoro ha il suo socket (CICCIO_SSH_BRIDGE), accanto a quello
// dell'agent SSH. ciccio-ssh-proxy (deploy/ssh-proxy.sh, il ProxyCommand di ssh nella sandbox) lo usa così:
//
//   client → "host porta\n"
//   Ciccio → "OK\n" e poi i byte della connessione TCP che il PC apre verso host:porta
//            "NO\n"         nessun PC collegato consente quella destinazione: il client va diretto (proxy della sandbox)
//            "ERR motivo\n" il PC c'è ma non ha aperto (non raggiungibile, troppi ponti…): il client si ferma
//
// Il PC che fa da ponte è quello che consente esattamente host:porta (ssh.ponti nella sua config); se sono più d'uno,
// quello collegato per ultimo. Nessuna card di approvazione qui: decide l'elenco del PC, e le chiavi SSH passano
// comunque dai consensi di 1Password. Nel registro della chat una riga quando un ponte si apre e quando si chiude.

const LINE_MAX = 300;
const HANDSHAKE_MS = 10_000;

export interface ChatSshBridge { path: string; close: () => void }

const kb = (n: number) => (n < 1024 ? `${n} byte` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * Un client del socket: legge la riga "host porta", chiede il ponte al PC e da lì in poi passa solo byte.
 * `onNote` scrive una riga nel registro della chat.
 */
export function serveBridgeClient(conn: net.Socket, onNote: (text: string) => void, signal?: AbortSignal) {
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => conn.destroy(), HANDSHAKE_MS);
  const answer = (line: string) => { clearTimeout(timer); if (!conn.destroyed) conn.end(`${line}\n`); };
  conn.on('error', () => undefined);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl < 0) { if (buf.length > LINE_MAX) answer('ERR riga troppo lunga: serve "host porta"'); return; }
    // Da qui il tempo lo decide la richiesta al PC (che apre la connessione entro 10 secondi).
    clearTimeout(timer);
    conn.off('data', onData);
    conn.pause();
    const rest = buf.subarray(nl + 1);
    if (rest.length) conn.unshift(rest);
    const parts = buf.subarray(0, nl).toString('latin1').replace(/\r$/, '').trim().split(/\s+/);
    const port = parts.length === 2 && /^\d{1,5}$/.test(parts[1]) ? Number(parts[1]) : NaN;
    const t = parts.length === 2 ? parseBridgeTarget(parts[0], port) : null;
    // Destinazione che nessun PC può consentire (IPv6, utente@, porta strana): si va diretti.
    if (!t) { answer('NO'); return; }
    void openBridgeOnPc(t.host, t.port, conn, (pc) => {
      clearTimeout(timer);
      conn.write('OK\n');
      onNote(`SSH: ponte dal PC "${pc}" verso ${t.key}`);
    }, (reason, st) => {
      onNote(`SSH: ponte verso ${t.key} chiuso (${reason}; ${kb(st.sent)} mandati, ${kb(st.received)} ricevuti)`);
    }, signal).then((r) => { if (!r) answer('NO'); }, (err: Error) => {
      const msg = err.message.replace(/[\r\n]+/g, ' ').slice(0, 300);
      onNote(`SSH: ponte verso ${t.key} non aperto: ${msg}`);
      answer(`ERR ${msg}`);
    });
  };
  conn.on('data', onData);
}

/** Apre il socket della chat (path: per le prove, es. una named pipe su Windows). */
export function openChatSshBridge(chatId: string, onNote: (text: string) => void, signal: AbortSignal, path = chatSocketPath(chatId, '-ponte')): ChatSshBridge {
  const conns = new Set<net.Socket>();
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    serveBridgeClient(conn, onNote, signal);
  });
  server.listen(path, () => { try { fs.chmodSync(path, 0o600); } catch { /* best effort */ } });
  server.on('error', (err) => onNote(`SSH: socket del ponte non disponibile (${err.message})`));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    // Giro finito: i comandi della sessione non ci sono più, i loro ponti si chiudono (e il PC chiude i suoi).
    for (const c of conns) c.destroy();
    if (!path.startsWith('\\\\')) fs.rmSync(path, { force: true });
  };
  signal.addEventListener('abort', close, { once: true });
  return { path, close };
}
