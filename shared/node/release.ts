import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { RELEASE_PUBLIC_KEYS } from '../release-key.js';

// Firma delle release (Ed25519): controlli del companion prima di installare un aggiornamento.
// Lo stesso formato lo scrive e lo controlla scripts/release-key.mjs (workflow di release, deploy/fetch-release.sh)
// e lo controlla l'app desktop in desktop/src-tauri/src/update.rs.
//
//   companion.json / app.json   { product, version, files: { <piattaforma>: Voce }, installers: { <piattaforma>: Voce } }
//                               Voce = { file, sha256, size, sig }: sig è la firma dei byte del file, in base64
//   companion.json.sig          firma dei byte esatti del manifest, in base64 (una riga)
//   <file>.sig                  firma dei byte del file, in base64 (per chi scarica a mano dalla release)

export type ReleaseProduct = 'companion' | 'app';
export interface SignedFile { file: string; sha256: string; size: number; sig: string }
export interface ReleaseManifest {
  product: ReleaseProduct;
  version: string;
  files: Record<string, SignedFile>;
  installers?: Record<string, SignedFile>;
}

/** Inizio DER di una chiave pubblica Ed25519 (SubjectPublicKeyInfo): seguono i 32 byte della chiave. */
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** Una chiave pubblica in base64 (32 byte), o null se non è una chiave (il segnaposto, un refuso). */
export function publicKeyFromBase64(b64: string): KeyObject | null {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(b64)) return null;
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== b64) return null;
  try { return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' }); } catch { return null; }
}

/** Le chiavi di shared/release-key.ts che sono chiavi vere: vuoto = c'è ancora il segnaposto, niente aggiornamenti. */
export function releaseKeys(list: readonly string[] = RELEASE_PUBLIC_KEYS): KeyObject[] {
  return list.map(publicKeyFromBase64).filter((k): k is KeyObject => k !== null);
}

export const NO_RELEASE_KEY = 'questa versione non ha la chiave pubblica delle release (c\'è ancora il segnaposto in shared/release-key.ts): aggiornamenti automatici spenti, si aggiorna a mano';

/** La firma (base64) dei dati è di una delle chiavi? */
export function signedBy(data: Buffer, sigB64: string, keys: KeyObject[]): boolean {
  if (typeof sigB64 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sigB64.trim())) return false;
  const sig = Buffer.from(sigB64.trim(), 'base64');
  return keys.some((k) => { try { return verify(null, data, k, sig); } catch { return false; } });
}

const isEntry = (e: unknown): e is SignedFile => {
  const f = e as SignedFile;
  return !!f && typeof f.file === 'string' && /^[\w.-]+$/.test(f.file) && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)
    && Number.isSafeInteger(f.size) && f.size > 0 && typeof f.sig === 'string';
};

/**
 * Controlla la firma di un manifest (testo esatto) e lo restituisce. Errore se la firma non è di una delle
 * chiavi, se il manifest non è di `product` o se una voce non è valida.
 */
export function openManifest(text: string, sigB64: string, keys: KeyObject[], product: ReleaseProduct): ReleaseManifest {
  if (!keys.length) throw new Error(NO_RELEASE_KEY);
  if (typeof text !== 'string' || typeof sigB64 !== 'string' || !text || !sigB64) throw new Error('aggiornamento senza firma: il server non ha il manifest firmato (pubblicato con una release firmata o con publish.sh e la chiave)');
  if (!signedBy(Buffer.from(text, 'utf8'), sigB64, keys)) throw new Error('firma del manifest non valida: non è di una release firmata con la chiave di questo programma');
  let m: ReleaseManifest;
  try { m = JSON.parse(text) as ReleaseManifest; } catch { throw new Error('manifest firmato ma non leggibile'); }
  if (m?.product !== product) throw new Error(`manifest firmato di un altro programma (${String(m?.product)}, qui serve ${product})`);
  if (typeof m.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(m.version)) throw new Error('manifest firmato con una versione non valida');
  for (const group of [m.files, m.installers ?? {}]) {
    if (!group || typeof group !== 'object') throw new Error('manifest firmato senza elenco dei file');
    for (const e of Object.values(group)) if (!isEntry(e)) throw new Error('manifest firmato con una voce non valida');
  }
  return m;
}

/** Controlla il file scaricato contro la sua voce del manifest firmato: dimensione, sha256 e firma. */
export function checkSignedFile(data: Buffer, entry: SignedFile, keys: KeyObject[]): void {
  if (data.length !== entry.size || createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new Error('file scaricato diverso da quello della release (dimensione o sha256)');
  if (!signedBy(data, entry.sig, keys)) throw new Error('firma del file non valida');
}
