// Prova delle migrazioni della config (server integrati arrivati dopo, una volta sola), del server «file»
// senza cartelle (le chiede l'agente con chiedi_accesso) e della ricarica dopo una sostituzione atomica fatta
// da fuori (config.json.tmp + rename), che con Bun su macOS arriva solo col nome del file temporaneo.
//
//   pnpm exec tsx companion/test/migrazioni.ts
//   bun companion/test/migrazioni.ts

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, migrateConfig, templateConfig, type FileEntry } from '../src/config.js';
import { LocalServer } from '../src/local.js';
import { LocalServers } from '../src/servers.js';
import { addRootToConfig } from '../src/access.js';
import type { AccessAnswer } from '../src/file.js';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-migrazioni-')));
process.env.CICCIO_COMPANION_HOME = path.join(tmp, '.ciccio-companion');
const cfgPath = path.join(tmp, '.ciccio-companion', 'config.json');
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });

let failed = false;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failed = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (f: () => boolean, ms = 5_000) => { for (const t0 = Date.now(); !f(); ) { if (Date.now() - t0 > ms) return false; await sleep(100); } return true; };
const read = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const write = (v: unknown) => fs.writeFileSync(cfgPath, `${JSON.stringify(v, null, 2)}\n`);
/** Come un editor o uno script da fuori: file temporaneo e rename sopra config.json. */
const replace = (v: unknown) => { fs.writeFileSync(`${cfgPath}.tmp`, `${JSON.stringify(v, null, 2)}\n`); fs.renameSync(`${cfgPath}.tmp`, cfgPath); };

try {
  // Config di una versione precedente alla 0.7.0: niente «comandi», niente «migrazioni», e una chiave sconosciuta.
  const old = { server: 'http://127.0.0.1:9', token: 'ccp_prova', altro: 42, mcpServers: { affinity: { type: 'sse', url: 'http://localhost:6767/sse' } } };
  write(old);
  ok(migrateConfig(cfgPath).join() === 'comandi,file', 'config vecchia: aggiunti «comandi» e «file»');
  let disk = read();
  ok(disk.mcpServers.comandi?.builtin === 'comandi' && disk.mcpServers.affinity && disk.token === 'ccp_prova' && disk.altro === 42, 'il resto della config resta com\'era');
  ok(disk.migrazioni?.join() === 'comandi,file' && disk.mcpServers.file?.builtin === 'file' && Array.isArray(disk.mcpServers.file.roots) && disk.mcpServers.file.roots.length === 0, 'segnate le migrazioni; «file» senza cartelle');
  const migrated = loadConfig(cfgPath).mcpServers;
  ok(migrated.comandi?.type === 'builtin' && migrated.file?.type === 'builtin', 'la config migrata è valida');
  const before = fs.readFileSync(cfgPath, 'utf8');
  ok(migrateConfig(cfgPath).length === 0 && fs.readFileSync(cfgPath, 'utf8') === before, 'al secondo avvio non cambia niente');

  // L'utente toglie «comandi» e «file» apposta: non ricompaiono.
  delete disk.mcpServers.comandi;
  delete disk.mcpServers.file;
  write(disk);
  ok(migrateConfig(cfgPath).length === 0 && !read().mcpServers.comandi && !read().mcpServers.file, '«comandi» e «file» tolti a mano non ricompaiono');

  // Config già migrata alla sola «comandi» (0.7.1 di prima): arriva solo «file».
  write({ ...old, migrazioni: ['comandi'] });
  ok(migrateConfig(cfgPath).join() === 'file' && !read().mcpServers.comandi && read().migrazioni.join() === 'comandi,file', 'migrazioni già fatte non si ripetono: solo quella nuova');

  // «comandi» già presente (anche con un altro nome): si segna soltanto.
  write({ ...old, mcpServers: { ...old.mcpServers, miei: { type: 'builtin', builtin: 'comandi', comandi: {} }, cartelle: { type: 'builtin', builtin: 'file', roots: [tmp] } } });
  ok(migrateConfig(cfgPath).length === 0 && !read().mcpServers.comandi && !read().mcpServers.file && read().migrazioni?.join() === 'comandi,file', 'server integrati già presenti con un altro nome: solo segnate');

  // Voci «comandi» e «file» che sono un'altra cosa non si toccano.
  write({ ...old, mcpServers: { comandi: { command: 'echo' }, file: { command: 'echo' } } });
  ok(migrateConfig(cfgPath).length === 0 && read().mcpServers.comandi.command === 'echo' && read().mcpServers.file.command === 'echo', 'voci con lo stesso nome ma di un altro tipo: non toccate');

  // Config non valida o assente: niente.
  fs.writeFileSync(cfgPath, '{ rotto');
  ok(migrateConfig(cfgPath).length === 0 && fs.readFileSync(cfgPath, 'utf8') === '{ rotto', 'config non valida: non si scrive');
  ok(migrateConfig(path.join(tmp, 'nessuna.json')).length === 0, 'config assente: niente');

  // Config nuova: ha già tutto, la migrazione non la tocca.
  write(templateConfig('ccp_prova', 'http://127.0.0.1:9'));
  const fresh = fs.readFileSync(cfgPath, 'utf8');
  ok(read().migrazioni?.join() === 'comandi,file' && migrateConfig(cfgPath).length === 0 && fs.readFileSync(cfgPath, 'utf8') === fresh, 'config nuova: già segnata, non cambia');
  ok(read().mcpServers.file?.roots?.length === 0, 'config nuova: «file» senza cartelle predefinite');

  // «file» senza cartelle: parte, ha chiedi_accesso, e «Consenti sempre» scrive nell'elenco vuoto.
  const fileEntry = loadConfig(cfgPath).mcpServers.file as FileEntry;
  const lavoro = path.join(tmp, 'Lavoro');
  fs.mkdirSync(lavoro);
  fs.writeFileSync(path.join(lavoro, 'a.stl'), 'SOLIDO');
  const replies: AccessAnswer[] = [];
  const fileServer = new LocalServer('file', fileEntry, { file: {
    ask: async () => replies.shift() ?? { scelta: 'no' },
    persist: (root) => addRootToConfig(cfgPath, 'file', root),
    timeoutMs: 2_000,
  } });
  await fileServer.start();
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await fileServer.call(name, args, new AbortController().signal);
    const t = (res.content[0] as { text: string }).text;
    return { err: !!res.isError, text: t, json: res.isError ? null : JSON.parse(t) as Record<string, any> };
  };
  ok(fileServer.state.status === 'online' && fileServer.state.tools.some((t) => t.name === 'chiedi_accesso'), '«file» con roots [] parte, con chiedi_accesso');
  ok(/Nessuna cartella consentita ancora/.test(fileServer.state.instructions ?? ''), 'istruzioni: nessuna cartella, chiedila con chiedi_accesso');
  let r = await call('elenca', {});
  ok(!r.err && r.json!.cartelleConsentite.length === 0 && /chiedi_accesso/.test(r.json!.nota), 'elenca senza cartelle: elenco vuoto e come chiederle');
  r = await call('copia', { da: path.join(lavoro, 'a.stl'), a: path.join(lavoro, 'b.stl') });
  ok(r.err && /chiedi_accesso/.test(r.text) && !fs.existsSync(path.join(lavoro, 'b.stl')), 'copia senza cartelle: rifiutata, dice di usare chiedi_accesso');
  replies.push({ scelta: 'sempre', solaLettura: false });
  r = await call('chiedi_accesso', { cartella: lavoro, solaLettura: false, motivo: 'Copia dello STL' });
  disk = read();
  ok(!r.err && r.json!.esito === 'consentita' && disk.mcpServers.file.roots.length === 1 && disk.mcpServers.file.roots[0].path === lavoro, '«Consenti sempre»: la cartella entra nell\'elenco vuoto della config');
  ok(loadConfig(cfgPath).mcpServers.file?.type === 'builtin' && disk.token === 'ccp_prova', 'la config resta valida, token intatto');
  r = await call('copia', { da: path.join(lavoro, 'a.stl'), a: path.join(lavoro, 'b.stl') });
  ok(!r.err && fs.readFileSync(path.join(lavoro, 'b.stl'), 'utf8') === 'SOLIDO', 'dopo il sì la copia funziona subito');
  await fileServer.stop();

  // Ricarica dopo una sostituzione atomica da fuori.
  write({ server: 'http://127.0.0.1:9', token: 'ccp_prova', mcpServers: {} });
  const local = new LocalServers(cfgPath, loadConfig(cfgPath), { interactive: false, confirm: async () => 'no' });
  await local.startAll();
  local.watch();
  await sleep(500);
  replace({ server: 'http://127.0.0.1:9', token: 'ccp_prova', mcpServers: { comandi: { type: 'builtin', builtin: 'comandi', comandi: {} } } });
  ok(await wait(() => local.map.has('comandi')), 'config.json.tmp + rename da fuori: config ricaricata');
  replace({ server: 'http://127.0.0.1:9', token: 'ccp_prova', mcpServers: {} });
  ok(await wait(() => !local.map.has('comandi')), 'e di nuovo, al secondo rename');
  write({ server: 'http://127.0.0.1:9', token: 'ccp_prova', mcpServers: { comandi: { type: 'builtin', builtin: 'comandi', comandi: {} } } });
  ok(await wait(() => local.map.has('comandi')), 'scrittura diretta: ricaricata come prima');
  await local.stopAll();
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? '\nPROVA FALLITA' : '\nTutto ok');
process.exit(failed ? 1 : 0);
