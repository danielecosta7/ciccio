import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { COMPANION_TRANSFER_PATH, MAX_TRANSFER_BYTES, TRANSFER_TOKEN, type TransferParams } from '../../shared/companion.js';
import { FileError, type TransferClient } from './file.js';

// File tra il repo dell'agente su Ciccio e il PC (scarica_da_ciccio, carica_su_ciccio del server «file»).
// Ciccio prepara la chiamata con un token monouso; il companion lo usa solo con il server della sua config e con
// il token del dispositivo, mai con un indirizzo arrivato da Ciccio. Dimensione e sha256 si controllano nei due versi.

const TRANSFER_TIMEOUT_MS = 10 * 60_000;

export function ciccioTransfer(serverUrl: string, deviceToken: string): TransferClient {
  const urlOf = (t: TransferParams) => {
    if (!TRANSFER_TOKEN.test(t.token)) throw new FileError('Token di trasferimento non valido.');
    return new URL(`${COMPANION_TRANSFER_PATH}/${t.token}`, serverUrl);
  };
  const auth = { Authorization: `Bearer ${deviceToken}` };
  const signalOf = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(TRANSFER_TIMEOUT_MS)]);
  const refused = async (res: Response) => {
    let msg = '';
    try { msg = String(((await res.json()) as { error?: unknown }).error ?? ''); } catch { /* non JSON */ }
    return new FileError(`Ciccio ha rifiutato il trasferimento (HTTP ${res.status})${msg ? `: ${msg.slice(0, 300)}` : ''}`);
  };

  return {
    async download(t, file, signal) {
      const size = t.dimensione;
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > MAX_TRANSFER_BYTES) throw new FileError('Dimensione del file non valida.');
      if (typeof t.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(t.sha256)) throw new FileError('sha256 del file non valido.');
      const res = await fetch(urlOf(t), { headers: auth, signal: signalOf(signal), redirect: 'error' });
      if (!res.ok || !res.body) throw await refused(res);
      const hash = createHash('sha256');
      let n = 0;
      // 'wx': il file temporaneo si crea nuovo, mai attraverso qualcosa che c'è già.
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          n += chunk.length;
          if (n > size) throw new FileError('Il file arrivato è più grande di quello annunciato da Ciccio.');
          hash.update(chunk);
          fs.writeSync(fd, chunk);
        }
      } finally { fs.closeSync(fd); }
      const sha256 = hash.digest('hex');
      if (n !== size || sha256 !== t.sha256) throw new FileError('Il file arrivato non corrisponde a quello su Ciccio (dimensione o sha256 diversi).');
      return { dimensione: n, sha256 };
    },

    async upload(t, data, signal) {
      const res = await fetch(urlOf(t), {
        method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: new Uint8Array(data),
        signal: signalOf(signal), redirect: 'error',
      });
      if (!res.ok) throw await refused(res);
      const r = (await res.json()) as { percorso?: unknown; dimensione?: unknown; sha256?: unknown };
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (r.dimensione !== data.length || r.sha256 !== sha256) throw new FileError('Il file arrivato su Ciccio non corrisponde (dimensione o sha256 diversi).');
      return { percorso: String(r.percorso ?? t.percorso), dimensione: data.length, sha256 };
    },
  };
}
