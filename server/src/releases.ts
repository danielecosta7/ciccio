import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { UpdateManifest, UpdateParams } from '../../shared/companion.js';

// Versioni pubblicate di companion e app desktop in <dataDir>/downloads: companion.json e app.json, con la
// loro firma (.json.sig). Le mette deploy/fetch-release.sh (release firmata su GitHub) o publish.sh.
// Il server non controlla le firme: le gira ai programmi, che le controllano con la chiave che hanno dentro
// (shared/release-key.ts) e rifiutano tutto il resto. Così un server compromesso non fa installare niente.

export const downloadsDir = () => path.join(config.dataDir, 'downloads');

interface Published { data: UpdateManifest; text: string; signature: string | null }
const cache = new Map<string, { stamp: string; value: Published | null }>();

const mtime = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };

/** Manifest pubblicato (testo esatto e firma), riletto solo quando uno dei due file cambia. */
export function published(name: 'companion.json' | 'app.json'): Published | null {
  const file = path.join(downloadsDir(), name);
  const stamp = `${mtime(file)}|${mtime(`${file}.sig`)}`;
  const hit = cache.get(name);
  if (hit?.stamp === stamp) return hit.value;
  let value: Published | null = null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const raw = JSON.parse(text) as UpdateManifest;
    let signature: string | null = null;
    try { signature = fs.readFileSync(`${file}.sig`, 'utf8').trim() || null; } catch { /* non firmato: i programmi lo rifiutano */ }
    if (typeof raw.version === 'string' && raw.files && typeof raw.files === 'object') value = { data: raw, text, signature };
  } catch { /* file non valido o assente: nessun aggiornamento */ }
  cache.set(name, { stamp, value });
  return value;
}

/** companion/update o desktop/update per chi ha `version` su `platform`, se c'è una versione più nuova. */
export function updateFor(name: 'companion.json' | 'app.json', downloadPath: string, platform: string | null, version: string | null, newer: (a: string, b: string) => boolean): UpdateParams | null {
  const p = published(name);
  const f = p && platform ? p.data.files[platform] : undefined;
  if (!p || !f || !version || !newer(p.data.version, version)) return null;
  if (!/^[\w.-]+$/.test(f.file) || !/^[0-9a-f]{64}$/.test(f.sha256)) return null;
  return {
    version: p.data.version, file: f.file, sha256: f.sha256, size: f.size, url: `${downloadPath}/${f.file}`,
    manifest: p.text, ...(p.signature ? { signature: p.signature } : {}),
  };
}

/** Il file è uno di quelli dell'aggiornamento automatico elencati nel manifest? */
export function listed(name: 'companion.json' | 'app.json', file: string): boolean {
  const m = published(name)?.data;
  return !!m && Object.values(m.files).some((f) => f.file === file);
}
