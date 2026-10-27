// Prova delle firme e dei consensi sul PC:
// - release: manifest e file firmati con una chiave usa e getta (come scripts/release-key.mjs), rifiuto di
//   firme sbagliate, prodotti scambiati, file cambiati, chiave segnaposto;
// - 1Password: solo accessi SSH (SSH_MSG_USERAUTH_REQUEST), server dal session-bind firmato (ed25519, RSA,
//   ECDSA) o da publickey-hostbound con il nome da known_hosts; finestre finte per segreti e firme SSH,
//   «Consenti sempre» nella config, 15 minuti, «No» che vale 10 minuti, nessuna finestra = solo la config.
//
//   pnpm exec tsx companion/test/firme.ts
//   bun companion/test/firme.ts

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { checkSignedFile, openManifest, publicKeyFromBase64, releaseKeys, signedBy } from '../../shared/node/release.js';
import { RELEASE_PUBLIC_KEYS } from '../../shared/release-key.js';
import { OnePasswordGuard, parseSshSign, sshTarget } from '../src/consensi.js';
import { loadConfig, templateConfig, writeConfig } from '../src/config.js';
import type { ChoiceRequest } from '../src/access.js';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-firme-')));
let failed = false;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failed = true; };
const throws = (f: () => unknown, re: RegExp, what: string) => {
  try { f(); ok(false, `${what} (nessun errore)`); } catch (e) { ok(re.test((e as Error).message), `${what}: ${(e as Error).message}`); }
};
const rejects = async (p: Promise<unknown>, re: RegExp, what: string) => {
  try { await p; ok(false, `${what} (nessun errore)`); } catch (e) { ok(re.test((e as Error).message), `${what}: ${(e as Error).message}`); }
};

// ── Release ─────────────────────────────────────────────────────────────

const raw = (k: KeyObject) => k.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
const pair = () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { pub: raw(publicKey), priv: privateKey }; };
const k1 = pair();
const k2 = pair();
const keys = releaseKeys([k1.pub, 'SEGNAPOSTO']);
ok(keys.length === 1, 'chiavi: il segnaposto non conta, la chiave vera sì');
ok(!RELEASE_PUBLIC_KEYS.some((k) => publicKeyFromBase64(k)) === (releaseKeys().length === 0), 'shared/release-key.ts letto (chiavi vere: ' + releaseKeys().length + ')');
ok(publicKeyFromBase64('AAAA') === null && publicKeyFromBase64(`${k1.pub.slice(0, -2)}A=`) !== undefined, 'chiavi non valide scartate');

const bin = Buffer.from('programma nuovo '.repeat(1000));
const entry = { file: 'CiccioCompanion-windows.exe', sha256: createHash('sha256').update(bin).digest('hex'), size: bin.length, sig: sign(null, bin, k1.priv).toString('base64') };
const manifest = `${JSON.stringify({ product: 'companion', version: '9.9.9', files: { 'win32-x64': entry, 'darwin-arm64': entry } }, null, 2)}\n`;
const msig = sign(null, Buffer.from(manifest), k1.priv).toString('base64');
const m = openManifest(manifest, msig, keys, 'companion');
ok(m.version === '9.9.9' && m.files['win32-x64'].file === entry.file, 'manifest firmato aperto');
checkSignedFile(bin, m.files['win32-x64'], keys);
ok(true, 'file firmato accettato');
throws(() => openManifest(manifest, msig, keys, 'app'), /altro programma/, 'manifest del companion offerto all\'app');
throws(() => openManifest(manifest.replace('9.9.9', '9.9.10'), msig, keys, 'companion'), /firma del manifest non valida/, 'manifest cambiato dopo la firma');
throws(() => openManifest(manifest, sign(null, Buffer.from(manifest), k2.priv).toString('base64'), keys, 'companion'), /firma del manifest non valida/, 'manifest firmato con un\'altra chiave');
throws(() => openManifest(manifest, '', keys, 'companion'), /senza firma/, 'manifest senza firma');
throws(() => openManifest(manifest, msig, [], 'companion'), /segnaposto/, 'senza chiave pubblica: niente aggiornamenti');
throws(() => checkSignedFile(Buffer.concat([bin, Buffer.from('x')]), entry, keys), /dimensione o sha256/, 'file diverso');
throws(() => checkSignedFile(bin, { ...entry, sig: sign(null, bin, k2.priv).toString('base64') }, keys), /firma del file/, 'file con la firma di un\'altra chiave');
ok(!signedBy(bin, 'non-base64', keys), 'firma malformata rifiutata');

// ── SSH: messaggi come li manda ssh ──────────────────────────────────────

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const str = (b: Buffer | string) => { const v = typeof b === 'string' ? Buffer.from(b) : b; return Buffer.concat([u32(v.length), v]); };
const mpint = (b: Buffer) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.subarray(i); if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]); return str(v); };
const frame = (type: number, body: Buffer) => Buffer.concat([u32(body.length + 1), Buffer.from([type]), body]);

const user = generateKeyPairSync('ed25519');
const userBlob = Buffer.concat([str('ssh-ed25519'), str(user.publicKey.export({ format: 'der', type: 'spki' }).subarray(12))]);
const sid = createHash('sha256').update('sessione').digest();
const payload = (o: { user?: string; method?: string; key?: Buffer; host?: Buffer; sid?: Buffer } = {}) => Buffer.concat([
  str(o.sid ?? sid), Buffer.from([50]), str(o.user ?? 'git'), str('ssh-connection'), str(o.method ?? 'publickey'), Buffer.from([1]), str('ssh-ed25519'), str(o.key ?? userBlob),
  ...(o.host ? [str(o.host)] : []),
]);
const signReq = (data: Buffer) => frame(13, Buffer.concat([str(userBlob), str(data), u32(0)]));

ok(parseSshSign(signReq(payload())).user === 'git', 'accesso SSH riconosciuto (utente git)');
throws(() => parseSshSign(signReq(Buffer.concat([Buffer.from('SSHSIG'), str('git'), str(''), str('sha512'), str(Buffer.alloc(64))]))), /solo accessi SSH/, 'firma di un commit (SSHSIG) rifiutata');
throws(() => parseSshSign(signReq(Buffer.from('dati qualsiasi da firmare'))), /solo accessi SSH/, 'dati qualsiasi rifiutati');
throws(() => parseSshSign(signReq(payload({ key: Buffer.concat([str('ssh-ed25519'), str(Buffer.alloc(32, 7))]) }))), /non è quella della richiesta/, 'chiave diversa nei dati');
throws(() => parseSshSign(signReq(payload({ user: 'git\nServer: github.com' }))), /nome utente/, 'nome utente con un a capo');
throws(() => parseSshSign(frame(11, Buffer.alloc(0))), /richiesta di firma/, 'non è una firma');

// Chiavi del server (ed25519, RSA, ECDSA) e il loro session-bind firmato.
type Host = { blob: Buffer; sig: (data: Buffer) => Buffer };
const hostEd = (() => {
  const k = generateKeyPairSync('ed25519');
  return { blob: Buffer.concat([str('ssh-ed25519'), str(k.publicKey.export({ format: 'der', type: 'spki' }).subarray(12))]), sig: (d: Buffer) => Buffer.concat([str('ssh-ed25519'), str(sign(null, d, k.privateKey))]) } satisfies Host;
})();
const hostRsa = (() => {
  const k = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const j = k.publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return { blob: Buffer.concat([str('ssh-rsa'), mpint(Buffer.from(j.e, 'base64url')), mpint(Buffer.from(j.n, 'base64url'))]), sig: (d: Buffer) => Buffer.concat([str('rsa-sha2-512'), str(sign('sha512', d, k.privateKey))]) } satisfies Host;
})();
const hostEc = (() => {
  const k = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = k.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const q = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]);
  return {
    blob: Buffer.concat([str('ecdsa-sha2-nistp256'), str('nistp256'), str(q)]),
    sig: (d: Buffer) => { const rs = sign('sha256', d, { key: k.privateKey, dsaEncoding: 'ieee-p1363' }); return Buffer.concat([str('ecdsa-sha2-nistp256'), str(Buffer.concat([mpint(rs.subarray(0, 32)), mpint(rs.subarray(32))]))]); },
  } satisfies Host;
})();
const bindOf = (h: Host, s = sid, sigOver = s) => frame(27, Buffer.concat([str('session-bind@openssh.com'), str(h.blob), str(s), str(h.sig(sigOver)), Buffer.from([0])]));

const knownHosts = path.join(tmp, 'known_hosts');
const typeOf = (h: Host) => h.blob.subarray(4, 4 + h.blob.readUInt32BE(0)).toString();
const line = (names: string, h: Host) => `${names} ${typeOf(h)} ${h.blob.toString('base64')}`;
fs.writeFileSync(knownHosts, [line('github.com,140.82.121.4', hostEd), line('[git.esempio.it]:2222', hostRsa), line('|1|c2FsZQ==|aGFzaA==', hostEc), ''].join('\n'));
const kh = [knownHosts];

const tEd = sshTarget(signReq(payload()), bindOf(hostEd), kh);
ok(tEd.user === 'git' && tEd.host === 'github.com', `session-bind ed25519 → ${tEd.user}@${tEd.host}`);
const tRsa = sshTarget(signReq(payload({ user: 'deploy' })), bindOf(hostRsa), kh);
ok(tRsa.host === '[git.esempio.it]:2222', `session-bind RSA (rsa-sha2-512) → ${tRsa.host}`);
const tEc = sshTarget(signReq(payload()), bindOf(hostEc), kh);
ok(tEc.host === 'un server di known_hosts (nome cifrato)', `session-bind ECDSA, nome cifrato → ${tEc.host}`);
const tHb = sshTarget(signReq(payload({ method: 'publickey-hostbound-v00@openssh.com', host: hostEd.blob })), null, kh);
ok(tHb.host === 'github.com', 'publickey-hostbound: chiave del server nei dati firmati → github.com');
const tBad = sshTarget(signReq(payload()), bindOf(hostEd, sid, Buffer.from('altra sessione')), kh);
ok(tBad.host === null && /non valida/.test(tBad.note ?? ''), 'session-bind con la firma sbagliata: server non verificato');
const tOther = sshTarget(signReq(payload()), bindOf(hostEd, createHash('sha256').update('altra').digest()), kh);
ok(tOther.host === null && tOther.hostFp === null, 'session-bind di un\'altra sessione: ignorato');
const tUnknown = sshTarget(signReq(payload()), bindOf(hostEd), [path.join(tmp, 'nessuno')]);
ok(tUnknown.host === null && tUnknown.hostFp?.startsWith('SHA256:'), 'server non in known_hosts: solo l\'impronta');
throws(() => sshTarget(signReq(payload({ method: 'publickey-hostbound-v00@openssh.com', host: hostRsa.blob })), bindOf(hostEd), kh), /diverse/, 'chiavi del server diverse');
fs.appendFileSync(knownHosts, `@revoked ${line('*', hostRsa)}\n`);
throws(() => sshTarget(signReq(payload()), bindOf(hostRsa), kh), /revocata/, 'chiave del server revocata');

// ── Consensi con finestre finte ─────────────────────────────────────────

const cfgPath = path.join(tmp, 'config.json');
writeConfig(cfgPath, templateConfig('ccp_prova', 'http://127.0.0.1:9'));
const asked: ChoiceRequest[] = [];
let answer: string | null = null;
const guard = new OnePasswordGuard(cfgPath, async (req) => { asked.push(req); return answer; }, kh);
const never = new AbortController().signal;
const REF = 'op://Lavoro/Servizio/credential';

answer = 'Consenti questa volta';
await guard.approveSecret(REF, 'chiamare l\'API\n\u202eal contrario', never);
ok(asked.length === 1 && asked[0].text.includes(REF) && !asked[0].text.includes('\u202e') && asked[0].buttons.join() === 'Consenti questa volta,Consenti sempre,No', 'segreto: finestra con il riferimento esatto, motivo ripulito');
answer = 'Consenti sempre';
await guard.approveSecret(REF, undefined, never);
ok(loadConfig(cfgPath).onePassword.segreti.includes(REF), '«Consenti sempre» scrive il riferimento nella config');
await guard.approveSecret(REF, undefined, never);
ok(asked.length === 2, 'riferimento consentito: niente finestra');
answer = 'No';
await rejects(guard.approveSecret('op://Lavoro/Altro/password', undefined, never), /risposto no/, 'segreto rifiutato sul PC');
await rejects(guard.approveSecret('op://Lavoro/Altro/password', undefined, never), /poco fa/, 'lo stesso, subito dopo: rifiutato senza finestra');
ok(asked.length === 3, 'nessuna finestra in più dopo il no');
answer = null;
await rejects(guard.approveSecret('op://Lavoro/Terzo/password', undefined, never), /nessuna risposta/, 'nessuna risposta: no');
await rejects(guard.approveSecret('op://non valido', undefined, never), /riferimento non valido/, 'riferimento non valido');

answer = 'Consenti per 15 minuti';
ok(/git@github\.com/.test(await guard.approveSsh(signReq(payload()), bindOf(hostEd), never)), 'firma SSH per git@github.com consentita');
ok(asked.at(-1)!.text.includes('Server: github.com') && asked.at(-1)!.buttons.length === 3, 'finestra SSH con utente e server');
const n = asked.length;
await guard.approveSsh(signReq(payload()), bindOf(hostEd), never);
ok(asked.length === n, 'entro 15 minuti: niente finestra');
answer = 'Consenti sempre';
await guard.approveSsh(signReq(payload({ user: 'deploy' })), bindOf(hostEd), never);
ok(loadConfig(cfgPath).onePassword.ssh.includes('deploy@github.com'), '«Consenti sempre» scrive deploy@github.com nella config');
const m2 = asked.length;
await guard.approveSsh(signReq(payload({ user: 'deploy' })), bindOf(hostEd), never);
ok(asked.length === m2, 'accesso consentito nella config: niente finestra');
answer = 'Consenti questa volta';
await guard.approveSsh(signReq(payload()), null, never);
ok(asked.at(-1)!.text.includes('SCONOSCIUTO') && asked.at(-1)!.buttons.join() === 'Consenti questa volta,No', 'server sconosciuto: solo «questa volta»');
await rejects(guard.approveSsh(signReq(Buffer.from('dati qualsiasi')), null, never), /solo accessi SSH/, 'firma di dati qualsiasi: rifiutata senza finestra');

const noWindow = new OnePasswordGuard(cfgPath, null, kh);
await noWindow.approveSecret(REF, undefined, never);
ok(true, 'senza finestra: il riferimento nella config passa');
await rejects(noWindow.approveSecret('op://Lavoro/Nuovo/password', undefined, never), /non c'è una finestra/, 'senza finestra: un riferimento nuovo no');

// Annullata da Ciccio mentre la finestra è aperta.
const slow = new OnePasswordGuard(null, (_req, signal) => new Promise((r) => signal.addEventListener('abort', () => r(null))), kh);
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 200);
await rejects(slow.approveSecret('op://Lavoro/Lento/password', undefined, ctrl.signal), /annullata/, 'richiesta annullata: la finestra si chiude');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? '\nPROVA FALLITA' : '\nPROVA RIUSCITA');
process.exit(failed ? 1 : 0);
