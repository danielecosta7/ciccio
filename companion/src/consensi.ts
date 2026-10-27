import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { OP_REF } from '../../shared/companion.js';
import { loadConfig, updateConfig } from './config.js';
import { pcChoose, type PcChoose } from './access.js';
import { dim, green, log, yellow } from './log.js';

// Consensi sul PC per 1Password: decide chi è davanti al PC, non Ciccio.
// L'approvazione in Ciccio non basta: un server compromesso potrebbe chiedere al companion qualunque
// segreto op:// o firme SSH oltre quelle che l'utente ha approvato. Quindi, sul PC:
// - lettura di un segreto: finestra con il riferimento op:// esatto; «Consenti sempre» lo aggiunge a
//   onePassword.segreti nella config, e da lì in poi passa senza finestra;
// - firma SSH: solo richieste di accesso SSH (SSH_MSG_USERAUTH_REQUEST), mai dati qualsiasi (commit, file,
//   token); la finestra dice utente e server. Il server è certo solo se la sua chiave è firmata nel messaggio
//   (publickey-hostbound di OpenSSH, o session-bind@openssh.com con la firma della chiave del server) e il
//   nome viene da ~/.ssh/known_hosts di questo PC. «Consenti per 15 minuti» vale per quell'utente su quel
//   server; «Consenti sempre» lo aggiunge a onePassword.ssh nella config.
// Dove non c'è una finestra (Linux) passa solo quello che è già nella config.
// Dopo un «No» la stessa richiesta si rifiuta da sola per 10 minuti, senza finestre a raffica.

const SSH_ASK_MS = 90_000;
const SECRET_ASK_MS = 120_000;
const SSH_WINDOW_MS = 15 * 60_000;
const REFUSED_MS = 10 * 60_000;

// ── Formato dei messaggi SSH (RFC 4251: uint32, byte, string con la lunghezza davanti) ──────────

class Reader {
  private o: number;
  constructor(private b: Buffer, start = 0) { this.o = start; }
  u32(): number {
    if (this.o + 4 > this.b.length) throw new Error('messaggio SSH troncato');
    const v = this.b.readUInt32BE(this.o);
    this.o += 4;
    return v;
  }
  byte(): number {
    if (this.o >= this.b.length) throw new Error('messaggio SSH troncato');
    return this.b[this.o++];
  }
  str(): Buffer {
    const n = this.u32();
    if (n > this.b.length - this.o) throw new Error('messaggio SSH troncato');
    const v = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return v;
  }
  text(): string { return this.str().toString('latin1'); }
  get done() { return this.o === this.b.length; }
}

const SIGN_REQUEST = 13;
const EXTENSION = 27;
const USERAUTH_REQUEST = 50;
const HOSTBOUND = 'publickey-hostbound-v00@openssh.com';

/** SHA256:… come lo scrive ssh-keygen -l. */
export const fingerprint = (blob: Buffer) => `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;

export interface SshSign { keyBlob: Buffer; sessionId: Buffer; user: string; hostKey: Buffer | null }

/**
 * Una richiesta di firma ssh-agent che deve essere un accesso SSH: i dati da firmare sono un
 * SSH_MSG_USERAUTH_REQUEST con il metodo publickey per la stessa chiave. Tutto il resto è un errore.
 */
export function parseSshSign(msg: Buffer): SshSign {
  if (msg.length < 5 || msg.readUInt32BE(0) !== msg.length - 4 || msg[4] !== SIGN_REQUEST) throw new Error('non è una richiesta di firma ssh-agent');
  const r = new Reader(msg, 5);
  const keyBlob = r.str();
  const data = r.str();
  r.u32();
  if (!r.done) throw new Error('richiesta di firma con dati in più');
  const notLogin = new Error('il PC firma solo accessi SSH (ssh, scp, git via ssh), non altri dati: firma rifiutata');
  try {
    const d = new Reader(data);
    const sessionId = d.str();
    if (sessionId.length < 16 || sessionId.length > 64 || d.byte() !== USERAUTH_REQUEST) throw notLogin;
    const user = d.str().toString('utf8');
    const service = d.text();
    const method = d.text();
    if (service !== 'ssh-connection' || (method !== 'publickey' && method !== HOSTBOUND) || d.byte() !== 1) throw notLogin;
    d.text(); // algoritmo della firma
    if (!d.str().equals(keyBlob)) throw new Error('la chiave nei dati non è quella della richiesta: firma rifiutata');
    const hostKey = method === HOSTBOUND ? Buffer.from(d.str()) : null;
    if (!d.done) throw notLogin;
    // Il nome utente finisce nella finestra: solo caratteri normali, niente a capo o inversioni del testo.
    if (!/^[\w.@+-]{1,64}$/.test(user)) throw new Error('nome utente SSH non valido: firma rifiutata');
    return { keyBlob: Buffer.from(keyBlob), sessionId: Buffer.from(sessionId), user, hostKey };
  } catch (err) {
    if (err === notLogin || (err as Error).message.includes('firma rifiutata')) throw err;
    throw notLogin;
  }
}

export interface SessionBind { hostKey: Buffer; sessionId: Buffer; signature: Buffer; forwarding: boolean }

/** session-bind@openssh.com: ssh lo manda all'agent dopo lo scambio di chiavi, prima di chiedere la firma. */
export function parseSessionBind(msg: Buffer): SessionBind | null {
  try {
    if (msg.length < 5 || msg.readUInt32BE(0) !== msg.length - 4 || msg[4] !== EXTENSION) return null;
    const r = new Reader(msg, 5);
    if (r.text() !== 'session-bind@openssh.com') return null;
    const hostKey = r.str(); const sessionId = r.str(); const signature = r.str();
    const forwarding = r.byte() !== 0;
    return r.done ? { hostKey: Buffer.from(hostKey), sessionId: Buffer.from(sessionId), signature: Buffer.from(signature), forwarding } : null;
  } catch { return null; }
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const b64url = (b: Buffer) => b.toString('base64url');
const unsigned = (mpint: Buffer) => { let i = 0; while (i < mpint.length - 1 && mpint[i] === 0) i++; return mpint.subarray(i); };
const fixed = (mpint: Buffer, size: number) => {
  const v = unsigned(mpint);
  if (v.length > size) throw new Error('numero troppo lungo');
  return Buffer.concat([Buffer.alloc(size - v.length), v]);
};
const EC = { nistp256: { crv: 'P-256', size: 32, hash: 'sha256' }, nistp384: { crv: 'P-384', size: 48, hash: 'sha384' }, nistp521: { crv: 'P-521', size: 66, hash: 'sha512' } } as const;

/** La firma (formato SSH) dei dati è della chiave del server? ed25519, RSA (sha2) ed ECDSA. */
export function hostSignatureValid(hostKey: Buffer, sigBlob: Buffer, data: Buffer): boolean {
  try {
    const k = new Reader(hostKey);
    const type = k.text();
    const s = new Reader(sigBlob);
    const alg = s.text();
    const sig = s.str();
    let key: KeyObject;
    if (type === 'ssh-ed25519') {
      const raw = k.str();
      if (alg !== type || raw.length !== 32) return false;
      key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
      return verify(null, data, key, sig);
    }
    if (type === 'ssh-rsa') {
      const hash = alg === 'rsa-sha2-256' ? 'sha256' : alg === 'rsa-sha2-512' ? 'sha512' : null;
      if (!hash) return false;
      const e = k.str(); const n = k.str();
      key = createPublicKey({ key: { kty: 'RSA', n: b64url(unsigned(n)), e: b64url(unsigned(e)) }, format: 'jwk' });
      return verify(hash, data, key, sig);
    }
    const m = /^ecdsa-sha2-(nistp256|nistp384|nistp521)$/.exec(type);
    if (m && alg === type) {
      const c = EC[m[1] as keyof typeof EC];
      if (k.text() !== m[1]) return false;
      const q = k.str();
      if (q[0] !== 4 || q.length !== 1 + 2 * c.size) return false;
      key = createPublicKey({ key: { kty: 'EC', crv: c.crv, x: b64url(q.subarray(1, 1 + c.size)), y: b64url(q.subarray(1 + c.size)) }, format: 'jwk' });
      const rs = new Reader(sig);
      const p1363 = Buffer.concat([fixed(rs.str(), c.size), fixed(rs.str(), c.size)]);
      return verify(c.hash, data, { key, dsaEncoding: 'ieee-p1363' }, p1363);
    }
    return false;
  } catch { return false; }
}

export const defaultKnownHosts = () => ['known_hosts', 'known_hosts2'].map((f) => path.join(os.homedir(), '.ssh', f));

/** Nome del server con questa chiave in known_hosts del PC: null se non c'è, 'revocata' se è segnata @revoked. */
export function knownHostName(hostKey: Buffer, files = defaultKnownHosts()): string | null | 'revocata' {
  let hashed = false;
  let name: string | null = null;
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (!parts[0] || parts[0].startsWith('#')) continue;
      const marker = parts[0].startsWith('@') ? parts.shift() : null;
      if (marker === '@cert-authority' || parts.length < 3) continue;
      let blob: Buffer;
      try { blob = Buffer.from(parts[2], 'base64'); } catch { continue; }
      if (!blob.equals(hostKey)) continue;
      // Una chiave revocata vale più di qualunque altra riga: si legge tutto prima di rispondere.
      if (marker === '@revoked') return 'revocata';
      if (marker || name) continue;
      const plain = parts[0].split(',').find((h) => !h.startsWith('|') && !/[*?!]/.test(h));
      if (plain && /^[\w.:[\]-]{1,255}$/.test(plain)) name = plain;
      else if (parts[0].startsWith('|')) hashed = true;
    }
  }
  return name ?? (hashed ? 'un server di known_hosts (nome cifrato)' : null);
}

export interface SshTarget { user: string; host: string | null; hostFp: string | null; keyFp: string; note?: string }

/**
 * Chi e dove: utente dai dati firmati; server dalla chiave firmata nei dati (publickey-hostbound) o dal
 * session-bind con la firma valida del server sulla stessa sessione, e il nome da known_hosts.
 */
export function sshTarget(msg: Buffer, bindMsg: Buffer | null, knownHosts?: string[]): SshTarget {
  const s = parseSshSign(msg);
  let hostKey = s.hostKey;
  let note: string | undefined;
  const bind = bindMsg ? parseSessionBind(bindMsg) : null;
  if (bind && !bind.forwarding && bind.sessionId.equals(s.sessionId)) {
    if (!hostSignatureValid(bind.hostKey, bind.signature, bind.sessionId)) note = 'firma del server non valida nel session-bind';
    else if (hostKey && !hostKey.equals(bind.hostKey)) throw new Error('chiavi del server diverse nella stessa richiesta: firma rifiutata');
    else hostKey = bind.hostKey;
  }
  if (!hostKey) return { user: s.user, host: null, hostFp: null, keyFp: fingerprint(s.keyBlob), note };
  const name = knownHostName(hostKey, knownHosts);
  if (name === 'revocata') throw new Error(`la chiave del server (${fingerprint(hostKey)}) è revocata in known_hosts: firma rifiutata`);
  return { user: s.user, host: name, hostFp: fingerprint(hostKey), keyFp: fingerprint(s.keyBlob), note };
}

// ── Finestre e config ───────────────────────────────────────────────────

/** Riferimenti e accessi consentiti per sempre su questo PC (config.json › onePassword). */
interface Allowed { segreti: string[]; ssh: string[] }

/** Testo scritto da altri (motivo dell'agente) nella finestra: una riga, senza caratteri che ingannano. */
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]+/g, ' ').trim().slice(0, max);

export class OnePasswordGuard {
  private queue: Promise<unknown> = Promise.resolve();
  private sshUntil = new Map<string, number>();
  private refused = new Map<string, number>();

  /** `configPath` null: niente elenco nella config (solo finestre). `choose` null: nessuna finestra. */
  constructor(private configPath: string | null, private choose: PcChoose | null = pcChoose() ?? null, private knownHosts?: string[]) {}

  private allowed(): Allowed {
    if (!this.configPath) return { segreti: [], ssh: [] };
    try { return loadConfig(this.configPath).onePassword; } catch { return { segreti: [], ssh: [] }; }
  }

  private remember(kind: keyof Allowed, value: string) {
    if (!this.configPath) return;
    try {
      updateConfig(this.configPath, (raw) => {
        const op = (raw.onePassword && typeof raw.onePassword === 'object' ? raw.onePassword : (raw.onePassword = {})) as Record<string, unknown>;
        const list = (Array.isArray(op[kind]) ? op[kind] : (op[kind] = [])) as string[];
        if (!list.includes(value)) list.push(value);
      });
    } catch (err) { log(yellow(`1Password · non riesco a scrivere nella config: ${(err as Error).message}`)); }
  }

  /** Una finestra alla volta; il tempo conta da quando arriva la richiesta (anche in coda). */
  private ask(title: string, text: string, buttons: string[], timeoutMs: number, signal: AbortSignal): Promise<string | null> {
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    const run = async () => {
      if (ctrl.signal.aborted || !this.choose) return null;
      const gone = new Promise<null>((r) => ctrl.signal.addEventListener('abort', () => r(null), { once: true }));
      return Promise.race([this.choose({ title, text, buttons, timeoutMs }, ctrl.signal), gone]);
    };
    const p = this.queue.then(run, run).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', stop); ctrl.abort(); });
    this.queue = p.catch(() => undefined);
    return p;
  }

  private checkRefused(key: string, what: string) {
    if ((this.refused.get(key) ?? 0) > Date.now()) throw new Error(`${what}: sul PC hanno risposto no poco fa, non riproporla adesso`);
  }

  /** Lettura di un segreto: consentita (nella config o dalla finestra) o errore con il motivo. */
  async approveSecret(ref: string, motivo: string | undefined, signal: AbortSignal): Promise<void> {
    if (typeof ref !== 'string' || !OP_REF.test(ref) || ref.length > 400) throw new Error('riferimento non valido: serve op://vault/elemento/campo');
    if (this.allowed().segreti.includes(ref)) { log(dim(`1Password · ${ref} già consentito su questo PC`)); return; }
    this.checkRefused(`op:${ref}`, `Lettura di ${ref}`);
    if (!this.choose) throw new Error(`su questo PC non c'è una finestra per confermare la lettura di ${ref}: aggiungilo a onePassword.segreti nella config del companion`);
    const why = motivo ? clean(motivo, 300) : '';
    const text = [
      'Un agente di Ciccio vuole leggere questo campo di 1Password:',
      ref,
      ...(why ? [`Motivo scritto dall'agente (non verificato):\n«${why}»`] : []),
      `Il valore va solo a Ciccio, per il comando che l'agente ha chiesto. «Consenti sempre» aggiunge questo riferimento alla config di questo PC: le volte dopo non chiede più (resta la conferma di 1Password, se è attiva). Senza risposta entro ${SECRET_ASK_MS / 60_000} minuti: no.`,
    ].join('\n\n');
    const buttons = ['Consenti questa volta', 'Consenti sempre', 'No'];
    log(`1Password · richiesta di lettura di ${ref}: chiedo sul PC`);
    const a = await this.ask('Ciccio chiede un segreto di 1Password', text, buttons, SECRET_ASK_MS, signal);
    if (a === buttons[1]) { this.remember('segreti', ref); log(`1Password · ${ref}: ${green('consentito sempre')}`); return; }
    if (a === buttons[0]) { log(`1Password · ${ref}: ${green('consentito questa volta')}`); return; }
    if (a === 'No') { this.refused.set(`op:${ref}`, Date.now() + REFUSED_MS); throw new Error(`sul PC hanno risposto no alla lettura di ${ref}`); }
    throw new Error(signal.aborted ? 'richiesta annullata' : `nessuna risposta sul PC entro ${SECRET_ASK_MS / 60_000} minuti per la lettura di ${ref}`);
  }

  /** Firma SSH: solo accessi, consentiti (config, 15 minuti o finestra). Restituisce «utente@server» per il registro. */
  async approveSsh(msg: Buffer, bind: Buffer | null, signal: AbortSignal): Promise<string> {
    const t = sshTarget(msg, bind, this.knownHosts);
    const who = t.host ? `${t.user}@${t.host}` : `${t.user} su un server non verificato`;
    const id = t.host ? `${t.user}@${t.host}` : null;
    if (id && this.allowed().ssh.includes(id)) return `${who} ${dim('(consentito su questo PC)')}`;
    if (id && (this.sshUntil.get(id) ?? 0) > Date.now()) return `${who} ${dim('(consentito per 15 minuti)')}`;
    const refusedKey = `ssh:${id ?? `${t.user}|${t.hostFp ?? '?'}`}`;
    this.checkRefused(refusedKey, `Firma SSH per ${who}`);
    if (!this.choose) throw new Error(`su questo PC non c'è una finestra per confermare la firma SSH per ${who}: aggiungi ${id ?? 'utente@server'} a onePassword.ssh nella config del companion`);
    const server = t.host
      ? `Server: ${t.host}\n(chiave del server ${t.hostFp}, firmata nella richiesta e uguale a quella in known_hosts di questo PC)`
      : t.hostFp
        ? `Server: NON VERIFICATO\nLa sua chiave (${t.hostFp}) non è in known_hosts di questo PC: controlla l'impronta prima di consentire.`
        : `Server: SCONOSCIUTO\nssh non ha detto a quale server serve la firma${t.note ? ` (${t.note})` : ''}: varrebbe per qualunque server che accetta questa chiave.`;
    const text = [
      'Un agente di Ciccio vuole accedere in SSH con una chiave di 1Password.',
      `Utente: ${t.user}\n${server}\nChiave: ${t.keyFp}`,
      t.host
        ? `«Consenti per 15 minuti» vale per ${id} (ssh, scp, git); «Consenti sempre» lo aggiunge alla config di questo PC. Poi 1Password chiede la sua conferma, se è attiva. Senza risposta entro ${SSH_ASK_MS / 1000} secondi: no.`
        : `«Consenti questa volta» vale solo per questo accesso. Poi 1Password chiede la sua conferma, se è attiva. Senza risposta entro ${SSH_ASK_MS / 1000} secondi: no.`,
    ].join('\n\n');
    const buttons = t.host ? ['Consenti per 15 minuti', 'Consenti sempre', 'No'] : ['Consenti questa volta', 'No'];
    log(`1Password · firma SSH per ${who}: chiedo sul PC`);
    const a = await this.ask('Ciccio chiede una firma SSH', text, buttons, SSH_ASK_MS, signal);
    if (a && a !== 'No') {
      if (id && a === 'Consenti sempre') this.remember('ssh', id);
      else if (id) this.sshUntil.set(id, Date.now() + SSH_WINDOW_MS);
      return `${who} ${dim(`(${a.toLowerCase()})`)}`;
    }
    if (a === 'No') { this.refused.set(refusedKey, Date.now() + REFUSED_MS); throw new Error(`sul PC hanno risposto no alla firma SSH per ${who}`); }
    throw new Error(signal.aborted ? 'richiesta annullata' : `nessuna risposta sul PC entro ${SSH_ASK_MS / 1000} secondi per la firma SSH per ${who}`);
  }
}
