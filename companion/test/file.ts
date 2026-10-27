// Prova del server MCP «file» integrato nel companion (gira ovunque, anche in CI Windows):
// percorsi fuori root, `..`, collegamenti simbolici (junction su Windows), copia con e senza
// sovrascrittura, backup prima di sovrascrivere, filtro allow/deny e stato del server,
// cartelle in sola lettura e chiedi_accesso (con una finta finestra al posto di quella del PC).
//
//   pnpm exec tsx companion/test/file.ts

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandPath, loadConfig, toolAllowed } from '../src/config.js';
import { LocalServer } from '../src/local.js';
import { addRootToConfig } from '../src/access.js';
import type { AccessAnswer, AccessRequest } from '../src/file.js';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-file-')));
// La cartella del companion (config con il token) di questa prova: nessuna cartella consentita la può contenere.
const casa = path.join(tmp, 'casa');
process.env.CICCIO_COMPANION_HOME = path.join(casa, '.ciccio-companion');
const lavoro = path.join(tmp, 'Desktop con spazio', 'lavoro');
const onedrive = path.join(tmp, 'OneDrive', 'Schede');
const fuori = path.join(tmp, 'fuori');
for (const d of [lavoro, onedrive, fuori]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(fuori, 'segreto.txt'), 'non toccare');

let failed = false;
const ok = (cond: unknown, what: string) => {
  console.log(`${cond ? '✓' : '✗'} ${what}`);
  if (!cond) failed = true;
};

const entry = {
  type: 'builtin' as const, builtin: 'file' as const,
  roots: [lavoro, { path: onedrive, backup: '_archivio/precedenti' }],
  deny: ['elenca_niente'],
};
const server = new LocalServer('file', entry);
await server.start();
ok(server.state.status === 'online', 'server file online');
ok(server.state.tools.map((t) => t.name).sort().join() === 'copia,crea_cartella,elenca,info', 'quattro strumenti: copia, crea_cartella, elenca, info');
ok(server.state.instructions?.includes(lavoro), 'le istruzioni elencano le cartelle consentite');

const call = async (name: string, args: Record<string, unknown>) => {
  const r = await server.call(name, args, new AbortController().signal);
  const t = (r.content[0] as { text: string }).text;
  return { err: !!r.isError, text: t, json: r.isError ? null : JSON.parse(t) as Record<string, any> };
};
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const read = (p: string) => fs.readFileSync(p, 'utf8');
/** Toglie un collegamento senza toccare dove punta. rmSync su una junction con Bun dà EFAULT: unlink, poi rmdir. */
const unlinkLink = (p: string) => { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } };

// Percorsi fuori dalle root
let r = await call('info', { percorso: path.join(fuori, 'segreto.txt') });
ok(r.err && /fuori dalle cartelle consentite/.test(r.text), 'info fuori root: rifiutato con messaggio chiaro');
r = await call('elenca', { percorso: fuori });
ok(r.err, 'elenca fuori root: rifiutato');
r = await call('crea_cartella', { percorso: path.join(fuori, 'nuova') });
ok(r.err && !fs.existsSync(path.join(fuori, 'nuova')), 'crea_cartella fuori root: rifiutato e niente creato');
r = await call('info', { percorso: 'relativo/file.txt' });
ok(r.err && /assoluto/.test(r.text), 'percorso relativo: rifiutato');

// ..
write(path.join(onedrive, 'a.af'), 'A');
r = await call('copia', { da: path.join(onedrive, '..', '..', 'fuori', 'segreto.txt'), a: path.join(lavoro, 'x.txt') });
ok(r.err && !fs.existsSync(path.join(lavoro, 'x.txt')), '.. nell\'origine che esce dalla root: rifiutato');
r = await call('copia', { da: path.join(onedrive, 'a.af'), a: path.join(lavoro, '..', '..', 'fuori', 'a.af') });
ok(r.err && !fs.existsSync(path.join(fuori, 'a.af')), '.. nella destinazione che esce dalla root: rifiutato');
r = await call('info', { percorso: path.join(lavoro, 'sotto', '..', '..', '..', 'fuori') });
ok(r.err, '.. annidati che escono: rifiutato');
r = await call('info', { percorso: path.join(lavoro, 'sotto', '..') });
ok(!r.err && r.json!.esiste, '.. che resta dentro la root: accettato');
r = await call('info', { percorso: path.join(tmp, 'Desktop con spazio', 'lavoro_altro') });
ok(r.err, 'cartella sorella con lo stesso prefisso (lavoro_altro): rifiutata');

// Collegamenti simbolici (junction su Windows)
const link = path.join(lavoro, 'esce');
try {
  fs.symlinkSync(fuori, link, process.platform === 'win32' ? 'junction' : 'dir');
  r = await call('elenca', { percorso: link });
  ok(r.err, 'collegamento a cartella fuori root: elenca rifiutato');
  r = await call('copia', { da: path.join(link, 'segreto.txt'), a: path.join(lavoro, 'rubato.txt') });
  ok(r.err && !fs.existsSync(path.join(lavoro, 'rubato.txt')), 'collegamento che esce: lettura attraverso di esso rifiutata');
  r = await call('copia', { da: path.join(onedrive, 'a.af'), a: path.join(link, 'a.af') });
  ok(r.err && !fs.existsSync(path.join(fuori, 'a.af')), 'collegamento che esce: scrittura attraverso di esso rifiutata');
  r = await call('crea_cartella', { percorso: path.join(link, 'x', 'y') });
  ok(r.err && !fs.existsSync(path.join(fuori, 'x')), 'collegamento che esce: crea_cartella rifiutato');
  r = await call('elenca', { percorso: lavoro });
  ok(!r.err && r.json!.voci.some((v: any) => v.nome === 'esce' && v.tipo === 'collegamento'), 'elenca mostra il collegamento come tale, senza seguirlo');
  r = await call('elenca', { percorso: lavoro, ricorsivo: true });
  ok(!r.err && !r.json!.voci.some((v: any) => /segreto/.test(v.nome)), 'elenca ricorsivo non scende nei collegamenti');
  // Collegamento interno alla root: va bene; dentro una cartella copiata non viene seguito.
  write(path.join(onedrive, 'dir', 'f.txt'), 'f');
  fs.symlinkSync(fuori, path.join(onedrive, 'dir', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  r = await call('copia', { da: path.join(onedrive, 'dir'), a: path.join(lavoro, 'dir') });
  ok(!r.err && read(path.join(lavoro, 'dir', 'f.txt')) === 'f' && !fs.existsSync(path.join(lavoro, 'dir', 'link')) && r.json!.collegamentiSaltati === 1, 'copia di cartella: i collegamenti dentro non si copiano');
  // Junction già presente in una sottocartella della destinazione: copiare una cartella sopra non deve scriverci attraverso.
  write(path.join(lavoro, 'pacco', 'sub', 'segreto.txt'), 'SOVRASCRITTO');
  write(path.join(lavoro, 'pacco', 'a.txt'), 'nuovo');
  fs.mkdirSync(path.join(onedrive, 'pacco'), { recursive: true });
  fs.symlinkSync(fuori, path.join(onedrive, 'pacco', 'sub'), process.platform === 'win32' ? 'junction' : 'dir');
  r = await call('copia', { da: path.join(lavoro, 'pacco'), a: path.join(onedrive, 'pacco'), sovrascrivi: true });
  ok(r.err && /collegamento/.test(r.text) && read(path.join(fuori, 'segreto.txt')) === 'non toccare', 'junction dentro la destinazione: copia rifiutata, niente scritto fuori');
  ok(!fs.existsSync(path.join(onedrive, 'pacco', 'a.txt')) && !fs.existsSync(path.join(onedrive, '_archivio', 'precedenti', 'pacco')), 'rifiuto prima di scrivere: nessuna copia o backup a metà');
  unlinkLink(path.join(onedrive, 'pacco', 'sub'));
  fs.rmSync(path.join(onedrive, 'pacco'), { recursive: true, force: true });
  // Junction nel percorso del backup: il backup non deve finire fuori.
  write(path.join(onedrive, 'Bk', 'PDF', 'q.pdf'), 'Q-VECCHIA');
  fs.mkdirSync(path.join(onedrive, '_archivio', 'precedenti'), { recursive: true });
  fs.symlinkSync(fuori, path.join(onedrive, '_archivio', 'precedenti', 'Bk'), process.platform === 'win32' ? 'junction' : 'dir');
  write(path.join(lavoro, 'q.pdf'), 'Q-NUOVA');
  r = await call('copia', { da: path.join(lavoro, 'q.pdf'), a: path.join(onedrive, 'Bk', 'PDF', 'q.pdf'), sovrascrivi: true });
  ok(r.err && !fs.existsSync(path.join(fuori, 'PDF')) && read(path.join(onedrive, 'Bk', 'PDF', 'q.pdf')) === 'Q-VECCHIA', 'junction nel percorso del backup: rifiutato, file e fuori intatti');
  unlinkLink(path.join(onedrive, '_archivio', 'precedenti', 'Bk'));
  fs.rmSync(path.join(onedrive, '_archivio'), { recursive: true, force: true });
  fs.rmSync(path.join(onedrive, 'Bk'), { recursive: true, force: true });
} catch (e) {
  ok(false, `prova dei collegamenti non eseguibile: ${(e as Error).message}`);
}

// Copia semplice, cartelle create, nessuna sovrascrittura di default
r = await call('copia', { da: path.join(onedrive, 'a.af'), a: path.join(lavoro, 'out', 'sotto', 'a.af') });
ok(!r.err && read(path.join(lavoro, 'out', 'sotto', 'a.af')) === 'A', 'copia crea le cartelle di destinazione');
ok(fs.readdirSync(path.join(lavoro, 'out', 'sotto')).join() === 'a.af', 'nessun file temporaneo rimasto');
write(path.join(onedrive, 'a.af'), 'A2');
r = await call('copia', { da: path.join(onedrive, 'a.af'), a: path.join(lavoro, 'out', 'sotto', 'a.af') });
ok(r.err && /esiste già/.test(r.text) && read(path.join(lavoro, 'out', 'sotto', 'a.af')) === 'A', 'destinazione esistente senza sovrascrivi: errore, file intatto');
r = await call('copia', { da: path.join(onedrive, 'a.af'), a: path.join(lavoro, 'out', 'sotto', 'a.af'), sovrascrivi: false });
ok(r.err, 'sovrascrivi=false: errore');
r = await call('copia', { da: path.join(onedrive, 'a.af'), a: path.join(lavoro, 'out', 'sotto', 'a.af'), sovrascrivi: true });
ok(!r.err && read(path.join(lavoro, 'out', 'sotto', 'a.af')) === 'A2' && !r.json!.backup, 'sovrascrivi=true: sostituisce; senza backup configurato (root lavoro) non ne crea');
ok(!fs.existsSync(path.join(lavoro, '_archivio')), 'nessuna cartella di backup nella root senza backup');

// Cartella copiata ricorsivamente, con data di modifica mantenuta
write(path.join(lavoro, 'pdf', 'Cat', 'p1.pdf'), 'P1');
write(path.join(lavoro, 'pdf', 'Cat', 'sub', 'p2.pdf'), 'P2');
r = await call('copia', { da: path.join(lavoro, 'pdf'), a: path.join(onedrive, 'pdfcopia') });
ok(!r.err && r.json!.file === 2 && read(path.join(onedrive, 'pdfcopia', 'Cat', 'sub', 'p2.pdf')) === 'P2', 'copia ricorsiva di una cartella');
r = await call('copia', { da: path.join(lavoro, 'pdf'), a: path.join(lavoro, 'pdf', 'dentro') });
ok(r.err && /dentro/.test(r.text), 'copia di una cartella dentro se stessa: rifiutata');
r = await call('copia', { da: path.join(lavoro, 'pdf', 'Cat', 'p1.pdf'), a: path.join(lavoro, 'pdf') });
ok(r.err, 'file sopra una cartella esistente: rifiutato (anche con sovrascrivi)');

// Backup prima di sovrascrivere
const bk = (...p: string[]) => path.join(onedrive, '_archivio', 'precedenti', ...p);
write(path.join(onedrive, 'Cat', 'PDF', 'p1.pdf'), 'VECCHIA');
r = await call('copia', { da: path.join(lavoro, 'pdf', 'Cat', 'p1.pdf'), a: path.join(onedrive, 'Cat', 'PDF', 'p1.pdf') });
ok(r.err && read(path.join(onedrive, 'Cat', 'PDF', 'p1.pdf')) === 'VECCHIA' && !fs.existsSync(bk()), 'senza sovrascrivi: errore, nessun backup, file intatto');
r = await call('copia', { da: path.join(lavoro, 'pdf', 'Cat', 'p1.pdf'), a: path.join(onedrive, 'Cat', 'PDF', 'p1.pdf'), sovrascrivi: true });
ok(!r.err && read(path.join(onedrive, 'Cat', 'PDF', 'p1.pdf')) === 'P1', 'sovrascrivi in root con backup: file sostituito');
ok(read(bk('Cat', 'PDF', 'p1.pdf')) === 'VECCHIA' && r.json!.backup === bk('Cat', 'PDF', 'p1.pdf'), 'backup con lo stesso percorso relativo alla root');
write(path.join(lavoro, 'pdf', 'Cat', 'p1.pdf'), 'P1-bis');
r = await call('copia', { da: path.join(lavoro, 'pdf', 'Cat', 'p1.pdf'), a: path.join(onedrive, 'Cat', 'PDF', 'p1.pdf'), sovrascrivi: true });
ok(!r.err && read(path.join(onedrive, 'Cat', 'PDF', 'p1.pdf')) === 'P1-bis' && read(bk('Cat', 'PDF', 'p1.pdf')) === 'VECCHIA', 'seconda sovrascrittura: il backup resta la versione più vecchia');
// Cartella intera
r = await call('copia', { da: path.join(lavoro, 'pdf'), a: path.join(onedrive, 'pdfcopia'), sovrascrivi: true });
ok(!r.err && read(bk('pdfcopia', 'Cat', 'sub', 'p2.pdf')) === 'P2', 'sovrascrivere una cartella: backup dell\'intera cartella esistente');
// Il backup non si sovrascrive a sua volta in cascata
r = await call('copia', { da: path.join(lavoro, 'pdf', 'Cat', 'p1.pdf'), a: bk('Cat', 'PDF', 'p1.pdf'), sovrascrivi: true });
ok(!r.err && !fs.existsSync(bk('_archivio')), 'scrivere dentro la cartella di backup non crea backup del backup');

// elenca, info, crea_cartella
r = await call('elenca', {});
ok(!r.err && r.json!.cartelleConsentite.length === 2, 'elenca senza percorso: le cartelle consentite');
r = await call('elenca', { percorso: path.join(lavoro, 'pdf'), ricorsivo: true });
ok(!r.err && r.json!.voci.length === 4 && r.json!.voci.some((v: any) => v.nome === 'Cat/sub/p2.pdf' && v.dimensione === 2 && v.modificato), 'elenca ricorsivo: nome relativo, dimensione, data');
r = await call('elenca', { percorso: path.join(lavoro, 'pdf'), ricorsivo: true, limite: 2 });
ok(!r.err && r.json!.voci.length === 2 && r.json!.troncato === true, 'elenca con limite: tronca e lo dice');
r = await call('info', { percorso: path.join(lavoro, 'pdf', 'Cat', 'p1.pdf') });
ok(!r.err && r.json!.esiste && r.json!.tipo === 'file' && r.json!.dimensione === 6, 'info di un file');
r = await call('info', { percorso: path.join(lavoro, 'non_esiste') });
ok(!r.err && r.json!.esiste === false, 'info di un percorso che non esiste: esiste=false');
r = await call('crea_cartella', { percorso: path.join(lavoro, 'n1', 'n2') });
ok(!r.err && fs.statSync(path.join(lavoro, 'n1', 'n2')).isDirectory() && r.json!.creata, 'crea_cartella con le intermedie');
r = await call('crea_cartella', { percorso: path.join(lavoro, 'n1', 'n2') });
ok(!r.err && r.json!.creata === false, 'crea_cartella su una cartella esistente: nessun errore');

// Maiuscole/minuscole (solo dove il file system le ignora)
if (process.platform === 'win32' || process.platform === 'darwin') {
  r = await call('info', { percorso: path.join(lavoro, 'pdf').toUpperCase() });
  ok(!r.err && r.json!.esiste, 'maiuscole diverse nel percorso: stessa cartella, accettata');
  r = await call('info', { percorso: path.join(fuori, '..', 'FUORI', 'segreto.txt') });
  ok(r.err, 'maiuscole diverse non aprono varchi fuori dalla root');
}

// Config e filtro
const raw = (e: unknown) => {
  const f = path.join(tmp, `cfg-${Math.random()}.json`);
  fs.writeFileSync(f, JSON.stringify({ token: 't', mcpServers: { file: e } }));
  return () => loadConfig(f);
};
ok(raw({ type: 'builtin', builtin: 'file', roots: ['~/Desktop/lavoro', { path: '%USERPROFILE%\\OneDrive', backup: '_archivio/precedenti' }] })().mcpServers.file !== undefined, 'config: voce file con roots valida');
ok(raw({ type: 'builtin', builtin: 'file', roots: [] })().mcpServers.file !== undefined && (raw({ type: 'builtin', builtin: 'file' })().mcpServers.file as { roots: unknown[] }).roots.length === 0, 'config: roots vuoto (o assente) valido: le cartelle si chiedono con chiedi_accesso');
let bad = false; try { raw({ type: 'builtin', builtin: 'file', roots: [{ path: 'x', backup: '../fuori' }] })(); } catch { bad = true; }
ok(bad, 'config: backup con .. = errore');
bad = false; try { raw({ type: 'builtin', builtin: 'file', roots: [{ path: 'x', backup: 'C:\\altro' }] })(); } catch { bad = true; }
ok(bad, 'config: backup assoluto = errore');
ok(!toolAllowed({ ...entry, allow: ['elenca', 'info'] }, 'copia') && toolAllowed({ ...entry, allow: ['elenca', 'info'] }, 'info'), 'filtro allow/deny sugli strumenti');
await server.stop();

const filtered = new LocalServer('file', { ...entry, allow: ['elenca', 'info'], deny: ['info'] });
await filtered.start();
ok(filtered.state.status === 'online' && filtered.state.tools.map((t) => t.name).join() === 'elenca', 'allow/deny della config: restano solo gli strumenti permessi');
let blocked = false; try { await filtered.call('copia', { da: onedrive, a: lavoro }, new AbortController().signal); } catch { blocked = true; }
ok(blocked, 'uno strumento escluso dal filtro non si può chiamare');
await filtered.stop();

// Una root che non esiste ancora (es. Desktop\lavoro nuovo): crea_cartella la crea, ma solo lei
const nuova = path.join(tmp, 'Desktop nuovo', 'lavoro');
const s3 = new LocalServer('file', { type: 'builtin', builtin: 'file', roots: [nuova] });
await s3.start();
const r3 = await s3.call('crea_cartella', { percorso: path.join(nuova, 'pdf') }, new AbortController().signal);
ok(!r3.isError && fs.existsSync(path.join(nuova, 'pdf')), 'root non ancora esistente: crea_cartella la crea');
await s3.stop();
ok(expandPath('~') === os.homedir(), 'expandPath come per gli altri server');

// Cartelle in sola lettura e chiedi_accesso
const prodotti = path.join(tmp, 'OneDrive', 'ACME SRL', 'Prodotti');
const fotoInst = path.join(prodotti, 'Sedia', 'Foto');
const desk = path.join(tmp, 'Desktop', 'affinity');
write(path.join(fotoInst, 'f1.jpg'), 'F1');
write(path.join(fotoInst, 'sub', 'f2.jpg'), 'F2');
fs.mkdirSync(desk, { recursive: true });
const asked: AccessRequest[] = [];
const replies: (AccessAnswer | 'mai')[] = [];
const saved: { path: string; solaLettura?: true }[] = [];
let persistFails = false;
const roEntry = { type: 'builtin' as const, builtin: 'file' as const, roots: [desk, { path: path.join(tmp, 'OneDrive', 'ACME SRL'), solaLettura: true }] as any[] };
const s4 = new LocalServer('file', roEntry, { file: {
  // Finta finestra del PC: risponde con la risposta in coda; «mai» non risponde (né chiude) finché non scade il tempo.
  ask: async (req) => { asked.push(req); const a = replies.shift() ?? { scelta: 'no' }; return a === 'mai' ? new Promise<AccessAnswer>(() => undefined) : a; },
  persist: (root) => { if (persistFails) throw new Error('disco pieno'); saved.push(root); },
  timeoutMs: 400,
} });
await s4.start();
const c4 = async (name: string, args: Record<string, unknown>) => {
  const res = await s4.call(name, args, new AbortController().signal);
  const t = (res.content[0] as { text: string }).text;
  return { err: !!res.isError, text: t, json: res.isError ? null : JSON.parse(t) as Record<string, any> };
};
const settle = () => new Promise((res) => setTimeout(res, 100));
const desc = (name: string) => s4.state.tools.find((t) => t.name === name)?.description ?? '';
ok(s4.state.tools.map((t) => t.name).sort().join() === 'chiedi_accesso,copia,crea_cartella,elenca,info', 'con la finestra del PC c\'è anche chiedi_accesso');
ok(/ACME SRL \(sola lettura/.test(s4.state.instructions ?? '') && /chiedi_accesso/.test(s4.state.instructions ?? ''), 'istruzioni: la cartella in sola lettura è indicata, e come chiedere le altre');
ok(desc('copia').includes(path.join(tmp, 'OneDrive', 'ACME SRL')) && desc('crea_cartella').includes('sola lettura'), 'descrizioni di copia e crea_cartella: quali cartelle sono in sola lettura');
r = await c4('elenca', {});
ok(!r.err && r.json!.cartelleConsentite.some((x: any) => x.solaLettura === true) && r.json!.cartelleConsentite.some((x: any) => !x.solaLettura), 'elenca senza percorso: segna le cartelle in sola lettura');

r = await c4('elenca', { percorso: fotoInst, ricorsivo: true });
ok(!r.err && r.json!.voci.length === 3, 'sola lettura: elenca funziona');
r = await c4('copia', { da: path.join(fotoInst, 'f1.jpg'), a: path.join(desk, 'f1.jpg') });
ok(!r.err && read(path.join(desk, 'f1.jpg')) === 'F1', 'copia da sola lettura a scrivibile: ok');
r = await c4('copia', { da: fotoInst, a: path.join(desk, 'foto') });
ok(!r.err && read(path.join(desk, 'foto', 'sub', 'f2.jpg')) === 'F2', 'copia di una cartella da sola lettura a scrivibile: ok');
r = await c4('copia', { da: path.join(desk, 'f1.jpg'), a: path.join(fotoInst, 'nuovo.jpg') });
ok(r.err && /sola lettura/.test(r.text) && !fs.existsSync(path.join(fotoInst, 'nuovo.jpg')), 'copia verso sola lettura: rifiutata, niente scritto');
write(path.join(desk, 'f1.jpg'), 'MODIFICATA');
r = await c4('copia', { da: path.join(desk, 'f1.jpg'), a: path.join(fotoInst, 'f1.jpg'), sovrascrivi: true });
ok(r.err && read(path.join(fotoInst, 'f1.jpg')) === 'F1', 'sovrascrivere in sola lettura: rifiutato, file intatto');
r = await c4('copia', { da: path.join(fotoInst, 'f1.jpg'), a: path.join(fotoInst, 'copia.jpg') });
ok(r.err && !fs.existsSync(path.join(fotoInst, 'copia.jpg')), 'copia dentro la stessa cartella in sola lettura: rifiutata');
r = await c4('crea_cartella', { percorso: path.join(fotoInst, 'nuova') });
ok(r.err && /sola lettura/.test(r.text) && !fs.existsSync(path.join(fotoInst, 'nuova')), 'crea_cartella in sola lettura: rifiutato');
try {
  // Junction da una cartella scrivibile verso una in sola lettura: dopo realpath vale la sola lettura.
  fs.symlinkSync(fotoInst, path.join(desk, 'verso_foto'), process.platform === 'win32' ? 'junction' : 'dir');
  r = await c4('copia', { da: path.join(desk, 'f1.jpg'), a: path.join(desk, 'verso_foto', 'x.jpg') });
  ok(r.err && !fs.existsSync(path.join(fotoInst, 'x.jpg')), 'junction da scrivibile a sola lettura: scrittura rifiutata');
  r = await c4('crea_cartella', { percorso: path.join(desk, 'verso_foto', 'nuova') });
  ok(r.err && !fs.existsSync(path.join(fotoInst, 'nuova')), 'junction da scrivibile a sola lettura: crea_cartella rifiutato');
  unlinkLink(path.join(desk, 'verso_foto'));
  // Junction dentro la cartella in sola lettura che esce: non si legge attraverso.
  fs.symlinkSync(fuori, path.join(prodotti, 'esce'), process.platform === 'win32' ? 'junction' : 'dir');
  r = await c4('copia', { da: path.join(prodotti, 'esce', 'segreto.txt'), a: path.join(desk, 'segreto.txt') });
  ok(r.err && !fs.existsSync(path.join(desk, 'segreto.txt')), 'junction che esce dalla cartella in sola lettura: lettura rifiutata');
  unlinkLink(path.join(prodotti, 'esce'));
} catch (e) {
  ok(false, `prova dei collegamenti in sola lettura non eseguibile: ${(e as Error).message}`);
}

// chiedi_accesso: «questa volta», in sola lettura
const altrove = path.join(tmp, 'Altrove', 'Foto');
write(path.join(altrove, 'a.jpg'), 'A');
replies.push({ scelta: 'una_volta', solaLettura: true });
r = await c4('chiedi_accesso', { cartella: altrove, solaLettura: true, motivo: 'Foto per la\nscheda\u0007 della sedia' });
ok(!r.err && r.json!.esito === 'consentita' && r.json!.solaLettura === true && /fino alle/.test(r.json!.valida), 'chiedi_accesso «questa volta»: consentita, con la scadenza');
ok(asked.length === 1 && asked[0].cartella === altrove && asked[0].solaLettura && asked[0].esiste && asked[0].motivo === 'Foto per la scheda della sedia', 'la finestra riceve cartella reale, accesso chiesto e motivo ripulito');
ok(saved.length === 0, '«questa volta» non tocca la config');
r = await c4('copia', { da: path.join(altrove, 'a.jpg'), a: path.join(desk, 'a.jpg') });
ok(!r.err && read(path.join(desk, 'a.jpg')) === 'A', 'cartella consentita: subito utilizzabile, senza riavvio');
r = await c4('copia', { da: path.join(desk, 'a.jpg'), a: path.join(altrove, 'b.jpg') });
ok(r.err && !fs.existsSync(path.join(altrove, 'b.jpg')), 'consentita in sola lettura: scrittura rifiutata');
await settle();
ok((s4.state.instructions ?? '').includes(altrove) && desc('copia').includes(altrove), 'istruzioni e descrizioni aggiornate con la cartella nuova');
r = await c4('chiedi_accesso', { cartella: path.join(altrove), solaLettura: true, motivo: 'di nuovo' });
ok(!r.err && r.json!.esito === 'già consentita' && asked.length === 1, 'cartella già consentita: nessuna finestra');
r = await c4('chiedi_accesso', { cartella: fotoInst, solaLettura: true, motivo: 'foto' });
ok(!r.err && r.json!.esito === 'già consentita' && asked.length === 1, 'sottocartella di una cartella consentita: nessuna finestra');

// «Sempre», in scrittura, per una sottocartella della cartella in sola lettura: vince la più specifica
const consegne = path.join(prodotti, 'Sedia', 'Consegne');
replies.push({ scelta: 'sempre', solaLettura: false });
r = await c4('chiedi_accesso', { cartella: consegne, solaLettura: false, motivo: 'Salvare il PDF finito' });
ok(!r.err && r.json!.esito === 'consentita' && /sempre/.test(r.json!.valida) && asked.length === 2 && !asked[1].esiste, 'chiedi_accesso «sempre» (cartella che non esiste ancora): consentita');
ok(saved.length === 1 && saved[0].path === consegne && !saved[0].solaLettura && roEntry.roots.some((x: any) => x.path === consegne), '«sempre»: salvata nella config e nell\'elenco vivo');
r = await c4('crea_cartella', { percorso: consegne });
ok(!r.err && fs.existsSync(consegne), 'cartella scrivibile dentro una in sola lettura: crea_cartella ok');
r = await c4('copia', { da: path.join(desk, 'a.jpg'), a: path.join(consegne, 'a.jpg') });
ok(!r.err && read(path.join(consegne, 'a.jpg')) === 'A', 'cartella scrivibile dentro una in sola lettura: copia ok');
r = await c4('copia', { da: path.join(desk, 'a.jpg'), a: path.join(prodotti, 'Sedia', 'a.jpg') });
ok(r.err && !fs.existsSync(path.join(prodotti, 'Sedia', 'a.jpg')), 'fuori dalla sottocartella la cartella resta in sola lettura');

// «Questa volta» ma scelta in sola lettura sul PC (casella), al posto della scrittura chiesta
const bozze = path.join(tmp, 'Bozze');
fs.mkdirSync(bozze);
replies.push({ scelta: 'una_volta', solaLettura: true });
r = await c4('chiedi_accesso', { cartella: bozze, solaLettura: false, motivo: 'bozze' });
ok(!r.err && r.json!.solaLettura === true && /solo in lettura/.test(r.json!.nota), 'sul PC si può concedere meno di quanto chiesto (solo lettura)');
r = await c4('crea_cartella', { percorso: path.join(bozze, 'x') });
ok(r.err && !fs.existsSync(path.join(bozze, 'x')), '...e allora non si scrive');

// No: rifiutata, e la stessa cartella non si richiede subito
const segreta = path.join(tmp, 'Privato');
fs.mkdirSync(segreta);
replies.push({ scelta: 'no' });
r = await c4('chiedi_accesso', { cartella: segreta, solaLettura: true, motivo: 'curiosità' });
ok(!r.err && r.json!.esito === 'rifiutata' && asked.length === 4, 'No: rifiutata');
r = await c4('elenca', { percorso: segreta });
ok(r.err, 'rifiutata: resta fuori');
r = await c4('chiedi_accesso', { cartella: segreta, solaLettura: true, motivo: 'per favore' });
ok(r.err && /rifiutato sul PC poco fa/.test(r.text) && asked.length === 4, 'dopo un No: nessuna nuova finestra per la stessa cartella');

// Nessuna risposta entro il tempo, e una sola richiesta alla volta
const lontana = path.join(tmp, 'Lontana');
fs.mkdirSync(lontana);
replies.push('mai');
const pending = c4('chiedi_accesso', { cartella: lontana, solaLettura: true, motivo: 'attesa' });
await new Promise((res) => setTimeout(res, 50));
r = await c4('chiedi_accesso', { cartella: bozze, solaLettura: false, motivo: 'intanto' });
ok(r.err && /già una richiesta/.test(r.text) && asked.length === 5, 'una richiesta alla volta: la seconda aspetta');
r = await pending;
ok(!r.err && r.json!.esito === 'nessuna risposta', 'nessuna risposta entro il tempo: «nessuna risposta» all\'agente');
r = await c4('elenca', { percorso: lontana });
ok(r.err, 'senza risposta: niente accesso');

// Config non salvabile: vale come «questa volta» e lo dice
const extra = path.join(tmp, 'Extra');
fs.mkdirSync(extra);
persistFails = true;
replies.push({ scelta: 'sempre', solaLettura: true });
r = await c4('chiedi_accesso', { cartella: extra, solaLettura: true, motivo: 'x' });
ok(!r.err && r.json!.esito === 'consentita' && /fino alle/.test(r.json!.valida) && /disco pieno/.test(r.json!.problema), 'config non salvabile: consentita solo questa volta, con il motivo');
persistFails = false;

// Richieste che non arrivano neanche alla finestra
const n = asked.length;
r = await c4('chiedi_accesso', { cartella: path.parse(tmp).root, solaLettura: true, motivo: 'tutto' });
ok(r.err && /troppo ampia/.test(r.text), 'radice del disco: rifiutata senza chiedere');
r = await c4('chiedi_accesso', { cartella: casa, solaLettura: true, motivo: 'casa' });
ok(r.err && /cartella del companion/.test(r.text), 'cartella che contiene la config del companion: rifiutata senza chiedere');
r = await c4('chiedi_accesso', { cartella: path.join(casa, '.ciccio-companion'), solaLettura: true, motivo: 'config' });
ok(r.err && /cartella del companion/.test(r.text), 'cartella del companion: rifiutata senza chiedere');
r = await c4('chiedi_accesso', { cartella: 'relativa', solaLettura: true, motivo: 'x' });
ok(r.err && /assoluto/.test(r.text), 'percorso relativo: rifiutato');
r = await c4('chiedi_accesso', { cartella: path.join(desk, 'a.jpg'), solaLettura: true, motivo: 'x' });
ok(r.err || r.json!.esito === 'già consentita', 'un file dentro una cartella consentita: niente finestra');
ok(asked.length === n, 'nessuna finestra per le richieste rifiutate in partenza');
await s4.stop();

// Cartella in sola lettura dentro una scrivibile: copiare sopra la madre non ci deve scrivere dentro
const w = path.join(tmp, 'W');
write(path.join(w, 'ro', 'x.txt'), 'ORIGINALE');
write(path.join(tmp, 'S', 'pacco', 'ro', 'x.txt'), 'SOVRASCRITTO');
const s6 = new LocalServer('file', { type: 'builtin', builtin: 'file', roots: [w, { path: path.join(w, 'ro'), solaLettura: true }, path.join(tmp, 'S')] });
await s6.start();
const r6 = await s6.call('copia', { da: path.join(tmp, 'S', 'pacco'), a: w, sovrascrivi: true }, new AbortController().signal);
ok(r6.isError && /sola lettura/.test((r6.content[0] as { text: string }).text) && read(path.join(w, 'ro', 'x.txt')) === 'ORIGINALE', 'copia sopra una cartella che contiene una cartella in sola lettura: rifiutata, niente scritto');
const r6b = await s6.call('copia', { da: path.join(tmp, 'S', 'pacco', 'ro', 'x.txt'), a: path.join(w, 'y.txt') }, new AbortController().signal);
ok(!r6b.isError && read(path.join(w, 'y.txt')) === 'SOVRASCRITTO', '...accanto, nella parte scrivibile, si copia');
await s6.stop();

// Una root nella config che contiene la cartella del companion: nessuna chiamata funziona
const s5 = new LocalServer('file', { type: 'builtin', builtin: 'file', roots: [casa] });
await s5.start();
const r5 = await s5.call('elenca', { percorso: casa }, new AbortController().signal);
ok(r5.isError && /cartella del companion/.test((r5.content[0] as { text: string }).text), 'root che contiene la config del companion: rifiutata');
await s5.stop();

// «Consenti sempre» sulla config vera: aggiunge la cartella, lascia il resto com'è
const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ server: 'https://ciccio.example.com', token: 'ccp_prova', notifications: true, mcpServers: {
  affinity: { type: 'sse', url: 'http://localhost:6767/sse' },
  'file pc': { type: 'builtin', builtin: 'file', roots: ['~/Desktop/x', { path: '~/OneDrive', solaLettura: true }] },
} }, null, 2));
addRootToConfig(cfgFile, 'file pc', { path: path.join(tmp, 'Nuova') });
let cfg = loadConfig(cfgFile);
const fr = (cfg.mcpServers['file pc'] as { roots: any[] }).roots;
ok(fr.length === 3 && fr[2].path === path.join(tmp, 'Nuova') && cfg.token === 'ccp_prova' && 'affinity' in cfg.mcpServers, 'addRootToConfig: cartella aggiunta, token e altri server intatti');
addRootToConfig(cfgFile, 'file pc', { path: path.join(os.homedir(), 'OneDrive') });
cfg = loadConfig(cfgFile);
const fr2 = (cfg.mcpServers['file pc'] as { roots: any[] }).roots;
ok(fr2.length === 3 && fr2[1].path === '~/OneDrive' && fr2[1].solaLettura === undefined, 'addRootToConfig sulla stessa cartella: cambia solo l\'accesso (da sola lettura a scrittura)');
bad = false; try { addRootToConfig(cfgFile, 'manca', { path: tmp }); } catch { bad = true; }
ok(bad && !fs.existsSync(`${cfgFile}.tmp`), 'addRootToConfig su una voce che non c\'è: errore, config intatta');
ok(raw({ type: 'builtin', builtin: 'file', roots: ['a', { path: 'b', backup: 'c' }, { path: 'd', solaLettura: true }] })().mcpServers.file !== undefined, 'config: stringhe, {path, backup} e {path, solaLettura} insieme');
bad = false; try { raw({ type: 'builtin', builtin: 'file', roots: [{ path: 'x', solaLettura: true, backup: 'b' }] })(); } catch { bad = true; }
ok(bad, 'config: sola lettura con backup = errore');

// scarica_da_ciccio e carica_su_ciccio con un finto Ciccio: cosa succede quando lo scaricamento va male a metà,
// e che il file preparato da Ciccio arrivi solo agli strumenti integrati (la prova con Ciccio vero è test/transfer.ts).
const arrivi = path.join(tmp, 'Arrivi');
fs.mkdirSync(arrivi, { recursive: true });
const sent: Buffer[] = [];
let downloadMode: 'ok' | 'rotto' = 'ok';
const s7 = new LocalServer('file', { type: 'builtin', builtin: 'file', roots: [{ path: arrivi, backup: '_vecchi' }] }, { file: { transfer: {
  async download(t, file) {
    fs.writeFileSync(file, downloadMode === 'ok' ? `contenuto di ${t.percorso}` : 'a metà');
    if (downloadMode === 'rotto') throw new Error('collegamento caduto');
    return { dimensione: 10, sha256: 'x' };
  },
  async upload(t, data) { sent.push(data); return { percorso: t.percorso, dimensione: data.length, sha256: 'y' }; },
} } });
await s7.start();
ok(s7.state.tools.filter((t) => t._meta?.['ciccio/transfer']).map((t) => `${t.name}:${t._meta!['ciccio/transfer']}`).sort().join() === 'carica_su_ciccio:upload,scarica_da_ciccio:download', 'con il trasferimento: scarica_da_ciccio e carica_su_ciccio, dichiarati a Ciccio con _meta');
const c7 = async (name: string, args: Record<string, unknown>, transfer?: Record<string, unknown>) => {
  const res = await s7.call(name, args, new AbortController().signal, transfer as never);
  return { err: !!res.isError, text: (res.content[0] as { text: string }).text };
};
const dl = { verso: 'download', token: 'T'.repeat(43), percorso: 'out/a.stl', dimensione: 10, sha256: '0'.repeat(64) };
let t7 = await c7('scarica_da_ciccio', { file_sul_server: 'out/a.stl', destinazione: path.join(arrivi, 'a.stl') });
ok(t7.err && /non ha preparato/.test(t7.text) && !fs.existsSync(path.join(arrivi, 'a.stl')), 'senza il file preparato da Ciccio: niente');
t7 = await c7('scarica_da_ciccio', { file_sul_server: 'out/a.stl', destinazione: path.join(arrivi, 'a.stl') }, { ...dl, verso: 'upload' });
ok(t7.err, 'trasferimento dell\'altro verso: rifiutato');
t7 = await c7('scarica_da_ciccio', { file_sul_server: 'out/a.stl', destinazione: path.join(arrivi, 'sotto', 'a.stl') }, dl);
ok(!t7.err && read(path.join(arrivi, 'sotto', 'a.stl')) === 'contenuto di out/a.stl', 'scaricato (cartelle intermedie create)');
downloadMode = 'rotto';
t7 = await c7('scarica_da_ciccio', { file_sul_server: 'out/a.stl', destinazione: path.join(arrivi, 'sotto', 'a.stl'), sovrascrivi: true }, dl);
ok(t7.err && read(path.join(arrivi, 'sotto', 'a.stl')) === 'contenuto di out/a.stl' && fs.readdirSync(path.join(arrivi, 'sotto')).length === 1 && !fs.existsSync(path.join(arrivi, '_vecchi')), 'scaricamento caduto a metà: file di prima intatto, niente temporanei né backup');
downloadMode = 'ok';
t7 = await c7('scarica_da_ciccio', { file_sul_server: 'out/a.stl', destinazione: arrivi }, dl);
ok(t7.err && /non la cartella consentita|cartella/.test(t7.text), 'destinazione = la cartella consentita: rifiutata (serve il percorso del file)');
t7 = await c7('scarica_da_ciccio', { file_sul_server: 'out/a.stl', destinazione: path.join(arrivi, 'sotto') }, dl);
ok(t7.err && /cartella/.test(t7.text), 'destinazione che è una cartella: rifiutata');
write(path.join(arrivi, 'grande.bin'), 'x'.repeat(100));
const ul = { verso: 'upload', token: 'U'.repeat(43), percorso: 'dal-pc/g.bin', massimo: 50 };
t7 = await c7('carica_su_ciccio', { file_sul_pc: path.join(arrivi, 'grande.bin'), destinazione_sul_server: 'dal-pc/g.bin' }, ul);
ok(t7.err && /troppo grande/.test(t7.text) && sent.length === 0, 'file più grande del massimo di Ciccio: non parte');
t7 = await c7('carica_su_ciccio', { file_sul_pc: path.join(arrivi, 'sotto'), destinazione_sul_server: 'dal-pc/g.bin' }, ul);
ok(t7.err && /Non è un file/.test(t7.text) && sent.length === 0, 'una cartella non si carica');
t7 = await c7('carica_su_ciccio', { file_sul_pc: path.join(arrivi, 'sotto', 'a.stl'), destinazione_sul_server: 'dal-pc/a.stl' }, { ...ul, percorso: 'dal-pc/a.stl' });
ok(!t7.err && sent[0]?.toString() === 'contenuto di out/a.stl', 'caricato: il contenuto va a Ciccio');
await s7.stop();
// Un server esterno non riceve mai il file preparato da Ciccio, né può dichiararsi un trasferimento.
const ext = new LocalServer('finto', { command: process.execPath, args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-finto-transfer.mjs')] });
await ext.start();
ok(ext.state.status === 'online' && ext.state.tools.length === 1 && !ext.state.tools[0]._meta, 'server esterno che si dichiara trasferimento: a Ciccio non arriva il _meta');
const re = ext.state.status === 'online' ? await ext.call('scarica_da_ciccio', {}, new AbortController().signal, dl as never) : null;
ok(re && !(re.content[0] as { text: string }).text.includes('ciccio/transfer'), '...e il file preparato da Ciccio non gli arriva');
await ext.stop();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? '\nFALLITA' : '\nTutto ok');
process.exit(failed ? 1 : 0);
