import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { execFile } from 'node:child_process';

// Firme SSH con la CLI op invece che con l'agent SSH di 1Password (solo sul Mac).
// Dalla 8.12.42 di 1Password per Mac (25/10/2026) l'agent SSH non mostra più la richiesta di approvazione alle
// app con la sola firma ad-hoc, come il companion: la firma resta in attesa e dopo 60 secondi 1Password chiude
// senza rispondere (e senza scriverlo nell'attività). La richiesta della CLI invece compare. Qui: si trova in
// 1Password l'elemento «chiave SSH» con la chiave pubblica chiesta, si legge la privata con op (1Password chiede
// l'approvazione), si firma nel processo e la chiave non resta da nessuna parte: né su disco né in una variabile
// che vive oltre la firma. Elenco delle chiavi e tutto il resto restano all'agent.

const SIGN_REQUEST = 13;
const SIGN_RESPONSE = 14;
const RSA_SHA2_256 = 2;
const RSA_SHA2_512 = 4;

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const str = (b: Buffer | string) => { const v = typeof b === 'string' ? Buffer.from(b) : b; return Buffer.concat([u32(v.length), v]); };
/** mpint di SSH: big-endian senza zeri in testa, con uno zero davanti se il primo bit è acceso. */
const mpint = (b: Buffer) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; const v = b.subarray(i); return str(v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v); };
const b64u = (s: string) => Buffer.from(s, 'base64url');

function readStr(buf: Buffer, at: number): [Buffer, number] {
  if (at + 4 > buf.length) throw new Error('richiesta di firma troncata');
  const len = buf.readUInt32BE(at);
  if (at + 4 + len > buf.length) throw new Error('richiesta di firma troncata');
  return [buf.subarray(at + 4, at + 4 + len), at + 4 + len];
}

/** Chiave, dati e flag di una SSH2_AGENTC_SIGN_REQUEST (con la lunghezza davanti). */
export function parseSignRequest(msg: Buffer): { keyBlob: Buffer; data: Buffer; flags: number } {
  if (msg.length < 5 || msg.readUInt32BE(0) !== msg.length - 4 || msg[4] !== SIGN_REQUEST) throw new Error('non è una richiesta di firma ssh-agent');
  const [keyBlob, a] = readStr(msg, 5);
  const [data, b] = readStr(msg, a);
  if (b + 4 !== msg.length) throw new Error('richiesta di firma non valida');
  return { keyBlob, data, flags: msg.readUInt32BE(b) };
}

const CURVES: Record<string, { name: string; hash: string; size: number }> = {
  'P-256': { name: 'nistp256', hash: 'sha256', size: 32 },
  'P-384': { name: 'nistp384', hash: 'sha384', size: 48 },
  'P-521': { name: 'nistp521', hash: 'sha512', size: 66 },
};

/** Chiave pubblica in formato SSH (quella dell'elenco dell'agent e delle richieste di firma). */
export function sshPublicBlob(key: KeyObject): Buffer {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  const jwk = pub.export({ format: 'jwk' }) as { kty: string; crv?: string; x?: string; y?: string; n?: string; e?: string };
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return Buffer.concat([str('ssh-ed25519'), str(b64u(jwk.x!))]);
  if (jwk.kty === 'RSA') return Buffer.concat([str('ssh-rsa'), mpint(b64u(jwk.e!)), mpint(b64u(jwk.n!))]);
  const c = jwk.kty === 'EC' && jwk.crv ? CURVES[jwk.crv] : undefined;
  if (c) return Buffer.concat([str(`ecdsa-sha2-${c.name}`), str(c.name), str(Buffer.concat([Buffer.from([4]), b64u(jwk.x!), b64u(jwk.y!)]))]);
  throw new Error('tipo di chiave non supportato per le firme SSH');
}

/**
 * Risposta ssh-agent (SSH2_AGENT_SIGN_RESPONSE, con la lunghezza davanti) a una richiesta di firma, fatta con
 * `key`. La chiave deve essere quella della richiesta: altrimenti errore, mai una firma con un'altra chiave.
 */
export function signRequest(msg: Buffer, key: KeyObject): Buffer {
  const { keyBlob, data, flags } = parseSignRequest(msg);
  if (!sshPublicBlob(key).equals(keyBlob)) throw new Error('la chiave di 1Password non è quella della richiesta');
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as { kty: string; crv?: string };
  let alg: string;
  let sig: Buffer;
  if (jwk.kty === 'OKP') {
    alg = 'ssh-ed25519';
    sig = sign(null, data, key);
  } else if (jwk.kty === 'RSA') {
    const hash = flags & RSA_SHA2_512 ? 'sha512' : flags & RSA_SHA2_256 ? 'sha256' : 'sha1';
    alg = hash === 'sha512' ? 'rsa-sha2-512' : hash === 'sha256' ? 'rsa-sha2-256' : 'ssh-rsa';
    sig = sign(hash, data, key);
  } else {
    const c = CURVES[jwk.crv ?? ''];
    if (!c) throw new Error('curva non supportata per le firme SSH');
    alg = `ecdsa-sha2-${c.name}`;
    const rs = sign(c.hash, data, { key, dsaEncoding: 'ieee-p1363' });
    sig = Buffer.concat([mpint(rs.subarray(0, c.size)), mpint(rs.subarray(c.size))]);
  }
  const body = Buffer.concat([Buffer.from([SIGN_RESPONSE]), str(Buffer.concat([str(alg), str(sig)]))]);
  return Buffer.concat([u32(body.length), body]);
}

/** PKCS#8 ed25519: 302e 020100 300506032b6570 0422 0420 <seed di 32 byte>. */
const ED25519_V1_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SEED = Buffer.from('300506032b6570042204', 'hex');

/**
 * Chiave privata dal PEM che dà op. Le chiavi ed25519 create in 1Password escono in PKCS#8 v2 (con la chiave
 * pubblica in coda): BoringSSL di Bun non le legge (WRONG_TAG), Node sì. Per quelle si riscrive il PKCS#8 v1
 * con lo stesso seed, e i buffer intermedi si azzerano.
 */
export function privateKeyFromPem(pem: Buffer): KeyObject {
  try {
    return createPrivateKey(pem);
  } catch (err) {
    // Il base64 fra le righe -----BEGIN/END----- del PEM.
    const lines = pem.toString().split('\n').filter((l) => !l.startsWith('-----')).join('');
    const der = lines ? Buffer.from(lines, 'base64') : null;
    const at = der ? der.indexOf(ED25519_SEED) : -1;
    if (!der || at < 0 || der[at + ED25519_SEED.length] !== 0x20 || at + ED25519_SEED.length + 33 > der.length) throw err;
    const v1 = Buffer.concat([ED25519_V1_PREFIX, der.subarray(at + ED25519_SEED.length + 1, at + ED25519_SEED.length + 33)]);
    try {
      return createPrivateKey({ key: v1, format: 'der', type: 'pkcs8' });
    } finally {
      v1.fill(0);
      der.fill(0);
    }
  }
}

function op(bin: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // 1Password chiede l'approvazione (Touch ID o password): fino a due minuti.
    execFile(bin, args, { timeout: 120_000, maxBuffer: 1024 * 1024, signal, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr.toString().replace(/\s+/g, ' ').trim().slice(0, 300) || err.message;
        reject(new Error(/not currently signed in|authorization|authenticat|cancel|dismiss/i.test(msg) ? `1Password non ha autorizzato la CLI (${msg})` : `op: ${msg}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Elemento 1Password di ogni chiave pubblica già vista (dati pubblici: solo in memoria, per non rifare l'elenco). */
const items = new Map<string, { vault: string; id: string }>();

async function findItem(bin: string, keyBlob: Buffer, signal?: AbortSignal): Promise<{ vault: string; id: string }> {
  const key = keyBlob.toString('base64');
  const known = items.get(key);
  if (known) return known;
  const list = JSON.parse((await op(bin, ['item', 'list', '--categories', 'SSH Key', '--format', 'json'], signal)).toString()) as { id: string; vault: { id: string } }[];
  for (const it of list) {
    const ref = { vault: it.vault.id, id: it.id };
    if ([...items.values()].some((v) => v.id === ref.id)) continue;
    const pub = (await op(bin, ['read', '--no-newline', `op://${ref.vault}/${ref.id}/public_key`], signal)).toString().trim().split(/\s+/)[1];
    if (pub) items.set(pub, ref);
    if (pub === key) return ref;
  }
  throw new Error('nessuna chiave SSH in 1Password corrisponde a quella chiesta');
}

/** Firma una richiesta ssh-agent leggendo la chiave privata con op. La risposta va a Ciccio come quella dell'agent. */
export async function opSshSign(bin: string, msg: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const { keyBlob } = parseSignRequest(msg);
  const ref = await findItem(bin, keyBlob, signal);
  const pem = await op(bin, ['read', '--no-newline', `op://${ref.vault}/${ref.id}/private_key`], signal);
  try {
    return signRequest(msg, privateKeyFromPem(pem));
  } catch (err) {
    // Chiave cambiata in 1Password dall'ultimo elenco: si rifà la ricerca la prossima volta.
    items.delete(keyBlob.toString('base64'));
    throw err;
  } finally {
    pem.fill(0);
  }
}
