#!/usr/bin/env node
// Chiave e firme delle release di companion e app desktop (Ed25519), senza dipendenze: solo Node.
//
//   node scripts/release-key.mjs genera
//       crea una coppia di chiavi: stampa la pubblica (va in shared/release-key.ts) e la privata
//       (va nel segreto CICCIO_RELEASE_KEY di GitHub), con le istruzioni.
//   node scripts/release-key.mjs chiave-pubblica
//       la chiave pubblica della privata in CICCIO_RELEASE_KEY (o CICCIO_RELEASE_KEY_FILE, o --chiave <file>).
//   node scripts/release-key.mjs manifest <companion|app> <versione> <cartella> <piattaforma>=<file>… [--installer <piattaforma>=<file>]…
//       scrive <cartella>/companion.json (o app.json) con sha256, dimensione e firma di ogni file, la firma del
//       manifest (.json.sig) e la firma separata di ogni file (<file>.sig). Chiave privata come sopra.
//   node scripts/release-key.mjs firma <file>…
//       solo le firme separate (<file>.sig).
//   node scripts/release-key.mjs verifica <cartella> [--chiave-pubblica <base64>]
//       controlla i manifest della cartella, i loro file e ogni <file>.sig con le chiavi di shared/release-key.ts
//       (o quella indicata). Esce con 1 al primo problema.
//
// Formato delle chiavi: privata PKCS#8 in PEM (quella che stampa «genera»), pubblica = i 32 byte in base64.
// Le firme sono Ed25519 dei byte esatti del file, in base64. Formato dei manifest: shared/node/release.ts.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const MANIFEST = { companion: 'companion.json', app: 'app.json' };

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const opt = (args, name) => {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name) { out.push(args[i + 1]); args.splice(i, 2); i--; }
  return out;
};

// ── Chiavi ──────────────────────────────────────────────────────────────

function publicKeyFromBase64(b64) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(b64)) return null;
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== b64) return null;
  try { return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' }); } catch { return null; }
}

const rawPublic = (key) => (key.type === 'public' ? key : createPublicKey(key)).export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519.length).toString('base64');

/** Le chiavi di shared/release-key.ts: una per riga, tra apici (stesso formato che legge update.rs). */
function committedKeys() {
  const text = fs.readFileSync(path.join(root, 'shared', 'release-key.ts'), 'utf8');
  return text.split('\n').map((l) => /^'([^']*)',?$/.exec(l.trim())?.[1]).filter((k) => k != null);
}

function trustedKeys(explicit) {
  const list = explicit.length ? explicit : committedKeys();
  const keys = list.map((b64) => ({ b64, key: publicKeyFromBase64(b64) })).filter((k) => k.key);
  if (!keys.length) die(explicit.length ? 'chiave pubblica non valida (servono 32 byte in base64)' : 'in shared/release-key.ts c\'è ancora il segnaposto: nessuna chiave pubblica con cui controllare (node scripts/release-key.mjs genera)');
  return keys;
}

function privateKey(args) {
  const file = opt(args, '--chiave')[0] ?? process.env.CICCIO_RELEASE_KEY_FILE;
  const pem = file ? fs.readFileSync(file, 'utf8') : process.env.CICCIO_RELEASE_KEY;
  if (!pem || !pem.trim()) die('manca la chiave privata delle release: segreto CICCIO_RELEASE_KEY (PEM PKCS#8), oppure CICCIO_RELEASE_KEY_FILE=<file> o --chiave <file>. Senza chiave non si firma e non si pubblica niente.');
  let key;
  try { key = createPrivateKey(pem.trim()); } catch (e) { die(`chiave privata non leggibile (serve il PEM PKCS#8 stampato da «genera»): ${e.message}`); }
  if (key.asymmetricKeyType !== 'ed25519') die(`la chiave privata è ${key.asymmetricKeyType}, serve Ed25519`);
  return key;
}

// ── Firme e manifest ────────────────────────────────────────────────────

const signFile = (key, file) => sign(null, fs.readFileSync(file), key).toString('base64');
function writeSig(key, file) {
  const sig = signFile(key, file);
  fs.writeFileSync(`${file}.sig`, `${sig}\n`);
  return sig;
}

function entry(key, dir, file) {
  if (!/^[\w.-]+$/.test(file)) die(`nome di file non valido: ${file}`);
  const abs = path.join(dir, file);
  if (!fs.existsSync(abs)) die(`manca ${abs}`);
  const data = fs.readFileSync(abs);
  return { file, sha256: createHash('sha256').update(data).digest('hex'), size: data.length, sig: writeSig(key, abs) };
}

function pairs(list, what) {
  return Object.fromEntries(list.map((p) => {
    const m = /^([a-z0-9]+-[a-z0-9]+)=(.+)$/.exec(p ?? '');
    if (!m) die(`${what}: serve piattaforma=file (es. darwin-arm64=CiccioCompanion-mac.zip), non «${p}»`);
    return [m[1], m[2]];
  }));
}

function writeManifest(args) {
  const installers = pairs(opt(args, '--installer'), '--installer');
  const key = privateKey(args);
  const [product, version, dir, ...rest] = args;
  if (!(product in MANIFEST)) die('prodotto: companion o app');
  if (!/^\d+(\.\d+){0,3}$/.test(version ?? '')) die(`versione non valida: ${version}`);
  if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) die(`cartella non trovata: ${dir}`);
  const files = pairs(rest, 'file');
  if (!Object.keys(files).length) die('nessun file da mettere nel manifest');
  const signed = {};
  const one = (file) => (signed[file] ??= entry(key, dir, file));
  const manifest = {
    product,
    version,
    files: Object.fromEntries(Object.entries(files).map(([p, f]) => [p, one(f)])),
    installers: Object.fromEntries(Object.entries(installers).map(([p, f]) => [p, one(f)])),
  };
  const out = path.join(dir, MANIFEST[product]);
  fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  writeSig(key, out);
  console.log(`${MANIFEST[product]}: ${product} ${version}, ${Object.keys(signed).length} file firmati (chiave ${rawPublic(key)})`);
}

// ── Verifica ────────────────────────────────────────────────────────────

function verifyDir(args) {
  const keys = trustedKeys(opt(args, '--chiave-pubblica'));
  const dir = args[0];
  if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) die(`cartella non trovata: ${dir}`);
  const ok = (data, sig) => /^[A-Za-z0-9+/]{86}==$/.test(String(sig).trim()) && keys.some(({ key }) => { try { return verify(null, data, key, Buffer.from(String(sig).trim(), 'base64')); } catch { return false; } });
  const checked = new Set();
  let manifests = 0;
  for (const [product, name] of Object.entries(MANIFEST)) {
    const abs = path.join(dir, name);
    if (!fs.existsSync(abs)) continue;
    manifests++;
    const text = fs.readFileSync(abs);
    const sigFile = `${abs}.sig`;
    if (!fs.existsSync(sigFile) || !ok(text, fs.readFileSync(sigFile, 'utf8'))) die(`${name}: firma assente o non valida`);
    checked.add(name).add(`${name}.sig`);
    let m;
    try { m = JSON.parse(text.toString('utf8')); } catch { die(`${name}: non è JSON`); }
    if (m.product !== product) die(`${name}: prodotto ${m.product}, atteso ${product}`);
    if (!/^\d+(\.\d+){0,3}$/.test(String(m.version))) die(`${name}: versione non valida`);
    for (const e of [...Object.values(m.files ?? {}), ...Object.values(m.installers ?? {})]) {
      if (!/^[\w.-]+$/.test(String(e?.file))) die(`${name}: voce non valida`);
      const f = path.join(dir, e.file);
      if (!fs.existsSync(f)) die(`${name}: manca ${e.file}`);
      const data = fs.readFileSync(f);
      if (data.length !== e.size || createHash('sha256').update(data).digest('hex') !== e.sha256) die(`${e.file}: dimensione o sha256 diversi dal manifest`);
      if (!ok(data, e.sig)) die(`${e.file}: firma nel manifest non valida`);
      checked.add(e.file);
    }
    console.log(`✓ ${name}: ${product} ${m.version}`);
  }
  if (!manifests) die(`nessun manifest (companion.json, app.json) in ${dir}`);
  // Le firme separate (per chi scarica a mano) devono essere giuste anche loro.
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.sig') || checked.has(name)) continue;
    const target = path.join(dir, name.slice(0, -4));
    if (!fs.existsSync(target)) die(`${name}: manca il file firmato`);
    if (!ok(fs.readFileSync(target), fs.readFileSync(path.join(dir, name), 'utf8'))) die(`${name}: firma non valida`);
    checked.add(name);
  }
  console.log(`✓ firme valide (chiave ${keys.length === 1 ? keys[0].b64 : `una di ${keys.length}`})`);
}

// ── Chiave nuova ────────────────────────────────────────────────────────

function generate() {
  const { publicKey, privateKey: priv } = generateKeyPairSync('ed25519');
  const pem = priv.export({ format: 'pem', type: 'pkcs8' }).toString().trim();
  const pub = rawPublic(publicKey);
  console.log(`Chiave delle release di Ciccio (Ed25519), creata adesso.

1. Chiave PUBBLICA: va nel repo, al posto del segnaposto in shared/release-key.ts (una riga tra apici),
   poi commit. I companion e le app compilati da lì accettano solo aggiornamenti firmati con questa chiave.

  '${pub}',

2. Chiave PRIVATA: va SOLO nel segreto del repo su GitHub, mai in un file del repo né in chat.
   GitHub › repo › Settings › Secrets and variables › Actions › New repository secret
   Nome: CICCIO_RELEASE_KEY   Valore: tutto il blocco qui sotto, righe BEGIN ed END comprese.
   (Oppure: salvalo in un file e  gh secret set CICCIO_RELEASE_KEY < file  poi cancella il file.)

${pem}

3. Tienine una copia al sicuro fuori da GitHub (per esempio in 1Password): GitHub non la mostra più e
   senza la privata non si può firmare una release che passi a una chiave nuova (vedi docs/tecnico.md).
   Poi chiudi o pulisci questo terminale.`);
}

// ── Main ────────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'genera': generate(); break;
  case 'chiave-pubblica': console.log(rawPublic(privateKey(args))); break;
  case 'manifest': writeManifest(args); break;
  case 'firma': {
    const key = privateKey(args);
    if (!args.length) die('quali file?');
    for (const f of args) { writeSig(key, f); console.log(`${f}.sig`); }
    break;
  }
  case 'verifica': verifyDir(args); break;
  case 'chiavi-del-repo': for (const { b64 } of trustedKeys([])) console.log(b64); break;
  default:
    console.error('Uso: node scripts/release-key.mjs genera | chiave-pubblica | manifest … | firma <file>… | verifica <cartella> | chiavi-del-repo');
    process.exit(1);
}
