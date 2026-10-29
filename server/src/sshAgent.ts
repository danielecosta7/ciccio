import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config, OWNER } from './config.js';
import { sshAgentOnPc } from './companion.js';

// Agent SSH per le sessioni degli agenti: ogni chat al lavoro ha il suo socket (SSH_AUTH_SOCK).
// ssh, scp e git lo usano come un agent qualsiasi; Ciccio gira i messaggi al companion del PC (Mac o
// Windows), che li passa all'agent SSH di 1Password. La chiave privata non arriva mai sul server.
//
// Solo due messaggi passano: elenco delle chiavi e firma. La firma la deve approvare l'utente in Ciccio
// (vale 15 minuti per quella chat), poi il companion chiede di nuovo sul PC (consensi.ts: solo accessi SSH,
// con utente e server; un Ciccio compromesso non può saltare quella finestra) e 1Password chiede Touch ID
// o Windows Hello.
// Il messaggio session-bind@openssh.com, che ssh manda dopo lo scambio di chiavi con il server remoto, si
// tiene per quel collegamento e si gira al PC insieme alla firma: con la firma della chiave del server il PC
// sa a quale server serve l'accesso.

const REQUEST_IDENTITIES = 11;
const IDENTITIES_ANSWER = 12;
const SIGN_REQUEST = 13;
const EXTENSION = 27;
const SUCCESS = 6;
const FAILURE = 5;
const MAX_MESSAGE = 256 * 1024;
/**
 * Quanto aspettare l'approvazione dell'utente prima di far fallire la firma. Il server SSH remoto chiude
 * il collegamento dopo 2 minuti senza accesso (LoginGraceTime): oltre, la firma arriverebbe a collegamento
 * già chiuso e l'agente vedrebbe solo «Connection closed». Meglio fallire prima, con un messaggio chiaro.
 */
const APPROVAL_WAIT_MS = 90_000;

const frame = (type: number, body = Buffer.alloc(0)) => {
  const out = Buffer.alloc(5 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out[4] = type;
  body.copy(out, 5);
  return out;
};
const failure = () => frame(FAILURE);
const noKeys = () => frame(IDENTITIES_ANSWER, Buffer.from([0, 0, 0, 0]));

export interface ChatSshAgent { path: string; close: () => void }

/**
 * Percorso di un socket della chat (agent SSH, ponte SSH): nella cartella dati, accessibile solo all'utente.
 * I socket Unix hanno un limite di ~100 caratteri sul percorso: con una cartella dati lunga si va in /tmp.
 */
export function chatSocketPath(chatId: string, suffix = ''): string {
  let dir = path.join(config.dataDir, 'ssh');
  if (dir.length > 80) dir = path.join(os.tmpdir(), `ciccio-ssh-${process.getuid?.() ?? 'u'}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sock = path.join(dir, `${chatId.replace(/[^\w-]/g, '')}${suffix}.sock`);
  fs.rmSync(sock, { force: true });
  return sock;
}

/**
 * Apre il socket della chat. `approve` chiede all'utente il permesso di firmare (true = consentito);
 * `onNote` scrive una riga nel registro della chat (es. «nessun PC con 1Password»).
 */
export function openChatSshAgent(chatId: string, approve: () => Promise<boolean>, onNote: (text: string) => void, signal: AbortSignal): ChatSshAgent {
  const sock = chatSocketPath(chatId);
  let noted = false;

  /** session-bind@openssh.com di questo collegamento, se ssh l'ha mandato. */
  const isSessionBind = (msg: Buffer) => msg.length > 9 && msg.readUInt32BE(5) === 24 && msg.subarray(9, 33).toString('latin1') === 'session-bind@openssh.com';

  const answer = async (msg: Buffer, conn: { bind: Buffer | null }): Promise<Buffer> => {
    const type = msg[4];
    if (type === EXTENSION && isSessionBind(msg)) { conn.bind = Buffer.from(msg); return frame(SUCCESS); }
    if (type !== REQUEST_IDENTITIES && type !== SIGN_REQUEST) return failure();
    if (type === SIGN_REQUEST) {
      // La richiesta di approvazione resta aperta anche se qui si smette di aspettare: approvata, vale
      // 15 minuti e il tentativo successivo passa subito.
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'tardi'>((r) => { timer = setTimeout(() => r('tardi'), APPROVAL_WAIT_MS); });
      const ok = await Promise.race([approve(), late]).finally(() => clearTimeout(timer));
      if (ok === 'tardi') {
        onNote(`SSH: firma non approvata entro 90 secondi, il server remoto avrebbe chiuso il collegamento. Quando ${OWNER} approva il permesso SSH in Ciccio, rilancia lo stesso comando: per 15 minuti passa senza chiedere di nuovo.`);
        return failure();
      }
      if (!ok) return failure();
    }
    try {
      const res = await sshAgentOnPc(msg, signal, type === SIGN_REQUEST ? conn.bind : null);
      if (res) return res;
      if (!noted) { noted = true; onNote('SSH: nessun PC collegato con l\'agent SSH di 1Password (serve il Mac o il PC Windows acceso con il companion).'); }
    } catch (err) {
      onNote(`SSH: ${(err as Error).message}`);
    }
    return type === REQUEST_IDENTITIES ? noKeys() : failure();
  };

  const server = net.createServer((conn) => {
    const state: { bind: Buffer | null } = { bind: null };
    let buf = Buffer.alloc(0);
    let busy = Promise.resolve();
    conn.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len < 1 || len > MAX_MESSAGE) { conn.destroy(); return; }
        if (buf.length < 4 + len) break;
        const msg = buf.subarray(0, 4 + len);
        buf = buf.subarray(4 + len);
        // Una risposta alla volta, nell'ordine delle richieste.
        busy = busy.then(async () => { const out = await answer(msg, state); if (!conn.destroyed) conn.write(out); });
      }
    });
    conn.on('error', () => undefined);
  });
  server.listen(sock, () => { try { fs.chmodSync(sock, 0o600); } catch { /* best effort */ } });
  server.on('error', (err) => onNote(`SSH: socket non disponibile (${err.message})`));
  const close = () => { server.close(); fs.rmSync(sock, { force: true }); };
  signal.addEventListener('abort', close, { once: true });
  return { path: sock, close };
}
