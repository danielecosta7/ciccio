// Prova del server MCP «comandi» integrato nel companion (gira ovunque, anche in CI Windows):
// segnaposto tipizzati controllati come i percorsi del server «file», niente shell, output e codice d'uscita,
// tempo massimo, proponi_comando e proponi_strumento (con una finta finestra al posto di quella del PC),
// chiavi solo come riferimenti a 1Password, e la config che si ricarica da sola (server nuovi, tolti, cambiati).
//
//   pnpm exec tsx companion/test/comandi.ts

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, placeholders, type CommandsEntry } from '../src/config.js';
import { LocalServer, setSecretReader } from '../src/local.js';
import { LocalServers } from '../src/servers.js';
import { findProgram, fillArgs, looksSecret } from '../src/comandi.js';
import type { ConfirmAnswer, ConfirmRequest } from '../src/access.js';

const WIN = process.platform === 'win32';
const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'fixtures', 'prova-comando.mjs');
const mcpEnv = path.join(here, 'fixtures', 'mcp-env.mjs');
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-comandi-')));
process.env.CICCIO_COMPANION_HOME = path.join(tmp, 'casa', '.ciccio-companion');
const lavoro = path.join(tmp, 'Lavoro con spazi');
const sola = path.join(tmp, 'Solo lettura');
const fuori = path.join(tmp, 'fuori');
for (const d of [lavoro, sola, fuori]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(sola, 'modello & co.stl'), 'SOLIDO');
fs.writeFileSync(path.join(fuori, 'segreto.stl'), 'NO');

let failed = false;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failed = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (f: () => boolean, ms = 10_000) => { for (const t0 = Date.now(); !f(); ) { if (Date.now() - t0 > ms) return false; await sleep(100); } return true; };
type Res = { err: boolean; text: string; json: Record<string, any> | null };
const callOf = (s: LocalServer) => async (name: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<Res> => {
  const r = await s.call(name, args, signal);
  const t = (r.content[0] as { text: string }).text;
  let json: Record<string, any> | null = null;
  try { json = JSON.parse(t); } catch { /* testo */ }
  return { err: !!r.isError, text: t, json };
};

// ── Config ───────────────────────────────────────────────────────────────
ok(JSON.stringify(placeholders('--out={uscita}')) === '["uscita"]' && JSON.stringify(placeholders('{{x}}')) === '[]' && placeholders('{aperta') === null, 'segnaposto: {nome}, {{ }} come graffe vere, graffe non chiuse rifiutate');
ok(JSON.stringify(fillArgs(['--in={a}', '{{"k":{n}}}', '{b}'], { a: 'C:\\x y', n: '3', b: '-z' })) === JSON.stringify(['--in=C:\\x y', '{"k":3}', '-z']), 'argomenti: valori al posto dei segnaposto, uno per argomento');
const cfgFile = path.join(tmp, 'cfg.json');
const cfgWith = (comandi: unknown) => { fs.writeFileSync(cfgFile, JSON.stringify({ token: 'x', mcpServers: { comandi: { type: 'builtin', builtin: 'comandi', comandi } } })); return cfgFile; };
let bad = '';
try { loadConfig(cfgWith({ prova: { programma: process.execPath, argomenti: ['{manca}'] } })); } catch (e) { bad = (e as Error).message; }
ok(/non è tra i parametri/.test(bad), 'config: segnaposto senza parametro = errore');
bad = '';
try { loadConfig(cfgWith({ prova: { programma: process.execPath, argomenti: [], parametri: { n: { tipo: 'numero' } } } })); } catch (e) { bad = (e as Error).message; }
ok(/non usato/.test(bad), 'config: parametro non usato = errore');
bad = '';
try { loadConfig(cfgWith({ 'Prova-1': { programma: process.execPath } })); } catch (e) { bad = (e as Error).message; }
ok(/Prova-1/.test(bad), 'config: nome del comando non valido = errore');
bad = '';
try { loadConfig(cfgWith({ prova: { programma: process.execPath, argomenti: ['{t}'], parametri: { t: { tipo: 'testo' } } } })); } catch (e) { bad = (e as Error).message; }
ok(!!bad, 'config: testo senza valori ammessi = errore');

// ── Comandi consentiti ───────────────────────────────────────────────────
const roots = [lavoro, { path: sola, solaLettura: true }];
const entry: CommandsEntry = {
  type: 'builtin', builtin: 'comandi',
  comandi: {
    prova: {
      descrizione: 'Copia il modello nell\'uscita.',
      programma: process.execPath,
      argomenti: [script, '--in={modello}', '{uscita}', '{n}', '{modo}'],
      parametri: {
        modello: { tipo: 'file', estensioni: ['.stl'] },
        uscita: { tipo: 'uscita', estensioni: ['.txt'] },
        n: { tipo: 'numero', intero: true, min: 0, max: 10, predefinito: 1 },
        modo: { tipo: 'testo', valori: ['ok', 'fallisci', 'dormi'], predefinito: 'ok' },
      },
      timeout: 2,
      cartella: lavoro,
    },
    mancante: { programma: path.join(tmp, WIN ? 'non-c-e.exe' : 'non-c-e'), argomenti: [], parametri: {}, timeout: 5 },
  },
};
const s1 = new LocalServer('comandi', entry, { comandi: { roots: () => roots } });
await s1.start();
const c1 = callOf(s1);
ok(s1.state.status === 'online' && s1.state.tools.map((t) => t.name).sort().join() === 'mancante,prova', 'due comandi = due strumenti; senza finestra sul PC niente proponi_*');
const tool = s1.state.tools.find((t) => t.name === 'prova')!;
const props = (tool.inputSchema as { properties?: Record<string, any>; required?: string[] }).properties ?? {};
ok(props.modo?.enum?.join() === 'ok,fallisci,dormi' && props.n?.type && (tool.inputSchema as { required?: string[] }).required?.sort().join() === 'modello,uscita', 'schema: testo come enum, numero, file e uscita obbligatori');
ok(tool.annotations?.readOnlyHint === false && /Lancia sul PC/.test(tool.description ?? ''), 'i comandi sono azioni (readOnlyHint false) e la descrizione dice cosa lancia');
ok(/prova/.test(s1.state.instructions ?? ''), 'istruzioni: elenco dei comandi');

const modello = path.join(sola, 'modello & co.stl');
const uscita = path.join(lavoro, 'sotto', 'uscita.txt');
let r = await c1('prova', { modello, uscita, n: 4 });
ok(!r.err && r.json?.codice === 0 && fs.readFileSync(uscita, 'utf8') === 'SOLIDO x4', `comando eseguito: modello da una cartella in sola lettura, uscita scritta (cartella creata) · ${r.json?.durata}`);
const printed = JSON.parse(String(r.json?.output ?? '{}').trim() || '{}') as { argomenti?: string[]; cwd?: string };
ok(printed.argomenti?.[0] === `--in=${modello}` && printed.argomenti?.[1] === uscita && printed.argomenti?.[3] === 'ok', 'niente shell: «&» e spazi nel nome arrivano dentro un argomento solo');
ok(printed.cwd && path.resolve(printed.cwd).toLowerCase() === lavoro.toLowerCase(), 'cartella di lavoro della config');
ok(r.json?.uscite?.[0]?.esiste === true && /fatto/.test(r.json?.errori ?? ''), 'risposta: uscite con esiste/dimensione, stderr in «errori»');
r = await c1('prova', { modello, uscita });
ok(r.err && /esiste già/.test(r.text), 'uscita che esiste già: rifiutata (la voce non ha sovrascrivi)');
r = await c1('prova', { modello: path.join(fuori, 'segreto.stl'), uscita: path.join(lavoro, 'b.txt') });
ok(r.err && /fuori dalle cartelle consentite/.test(r.text), 'modello fuori dalle cartelle consentite: rifiutato');
r = await c1('prova', { modello, uscita: path.join(sola, 'b.txt') });
ok(r.err && /sola lettura/.test(r.text) && !fs.existsSync(path.join(sola, 'b.txt')), 'uscita in una cartella in sola lettura: rifiutata');
r = await c1('prova', { modello, uscita: path.join(fuori, 'b.txt') });
ok(r.err && /fuori dalle cartelle consentite/.test(r.text), 'uscita fuori dalle cartelle consentite: rifiutata');
r = await c1('prova', { modello, uscita: path.join(lavoro, 'b.exe') });
ok(r.err && /estensione/.test(r.text), 'uscita con estensione non ammessa: rifiutata');
r = await c1('prova', { modello: path.join(lavoro, 'non-c-e.stl'), uscita: path.join(lavoro, 'b.txt') });
ok(r.err && /non esiste/.test(r.text), 'modello che non esiste: rifiutato');
r = await c1('prova', { modello: 'relativo.stl', uscita: path.join(lavoro, 'b.txt') });
ok(r.err && /assoluto/.test(r.text), 'percorso relativo: rifiutato');
r = await c1('prova', { modello, uscita: path.join(lavoro, 'b.txt'), n: 11 });
ok(r.err && !fs.existsSync(path.join(lavoro, 'b.txt')), 'numero fuori intervallo: rifiutato, niente lanciato');
r = await c1('prova', { modello, uscita: path.join(lavoro, 'b.txt'), modo: 'rm -rf' });
ok(r.err && !fs.existsSync(path.join(lavoro, 'b.txt')), 'testo fuori dai valori ammessi: rifiutato');
// Collegamento che porta fuori (junction su Windows): l'uscita non ci passa.
const link = path.join(lavoro, 'scorciatoia');
fs.symlinkSync(fuori, link, 'junction');
r = await c1('prova', { modello, uscita: path.join(link, 'b.txt') });
ok(r.err && !fs.existsSync(path.join(fuori, 'b.txt')), 'uscita attraverso una junction che porta fuori: rifiutata');
r = await c1('prova', { modello, uscita: path.join(lavoro, 'f.txt'), modo: 'fallisci' });
ok(r.err && r.json?.codice === 3 && /qualcosa non va/.test(r.json?.errori ?? ''), 'codice d\'uscita diverso da 0: errore, con stderr');
const t0 = Date.now();
r = await c1('prova', { modello, uscita: path.join(lavoro, 'd.txt'), modo: 'dormi' });
ok(r.err && /chiuso dopo 2 s/.test(r.json?.scaduto ?? '') && Date.now() - t0 < 8000, `tempo massimo: chiuso dopo ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const ctrl = new AbortController();
const pending = c1('prova', { modello, uscita: path.join(lavoro, 'e.txt'), modo: 'dormi' }, ctrl.signal);
await sleep(300);
const busy = await c1('prova', { modello, uscita: path.join(lavoro, 'g.txt') });
ok(busy.err && /già in corso/.test(busy.text), 'lo stesso comando due volte insieme: il secondo aspetta');
ctrl.abort();
r = await pending.catch(() => ({ err: true, text: 'interrotto', json: null }));
ok(r.err, 'chiamata interrotta da Ciccio: programma chiuso');
r = await c1('mancante', {});
ok(r.err && /non trovato/.test(r.text), 'programma che non c\'è: errore chiaro');
await s1.stop();

// ── Proposte (finta finestra) ────────────────────────────────────────────
const asked: ConfirmRequest[] = [];
const replies: ConfirmAnswer[] = [];
const confirm = async (req: ConfirmRequest) => { asked.push(req); return replies.shift() ?? 'no'; };
const savedCommands: Record<string, unknown> = {};
const added: Record<string, Record<string, unknown>> = {};
const entry2: CommandsEntry = { type: 'builtin', builtin: 'comandi', comandi: {} };
const s2 = new LocalServer('comandi', entry2, { comandi: {
  roots: () => roots, confirm,
  saveCommand: (n, c) => { savedCommands[n] = c; },
  addServer: async (n, e) => { added[n] = e; return { stato: 'online', strumenti: 1 }; },
  serverNames: () => ['file', 'comandi', 'affinity'],
  timeoutMs: 500,
} });
await s2.start();
const c2 = callOf(s2);
ok(s2.state.tools.map((t) => t.name).sort().join() === 'proponi_comando,proponi_strumento', 'con la finestra sul PC: proponi_comando e proponi_strumento');
const proposal = {
  nome: 'copia_stl', descrizione: 'Copia un STL', programma: process.execPath,
  argomenti: [script, '--in={modello}', '{uscita}', '1', 'ok'],
  parametri: { modello: { tipo: 'file', estensioni: ['.stl'] }, uscita: { tipo: 'uscita' } },
  motivo: 'Per preparare i file di stampa.\nSecondo rigo',
};
replies.push('sì');
r = await c2('proponi_comando', proposal);
const shownBody = asked.at(-1)?.text ?? '';
ok(!r.err && r.json?.esito === 'consentito' && !!savedCommands.copia_stl, 'proponi_comando + «Consenti sempre»: salvato nella config');
ok(shownBody.includes(process.execPath) && shownBody.includes('--in={modello}') && /\{modello\} = un file in una cartella consentita \(\.stl\)/.test(shownBody), 'finestra: programma e argomenti esatti, con cosa può scegliere l\'agente');
ok(/interprete/.test(shownBody) && /«Per preparare i file di stampa\. Secondo rigo»/.test(shownBody), 'finestra: avviso per un interprete (node) e motivo su una riga');
ok(await wait(() => s2.state.tools.some((t) => t.name === 'copia_stl')), 'il comando nuovo è subito uno strumento (tools/list_changed)');
r = await c2('copia_stl', { modello, uscita: path.join(lavoro, 'nuovo.txt') });
ok(!r.err && fs.existsSync(path.join(lavoro, 'nuovo.txt')), 'e funziona');
const n0 = asked.length;
r = await c2('proponi_comando', { ...proposal, motivo: 'di nuovo' });
ok(r.err && /già uno strumento/.test(r.text) && asked.length === n0, 'stesso nome: rifiutato senza finestra');
r = await c2('proponi_comando', { ...proposal, nome: 'con_chiave', argomenti: [script, '--api-key=sk-abcdefghijklmnopqrstuvwx'] , parametri: {} });
ok(r.err && /chiave/.test(r.text) && asked.length === n0, 'chiave negli argomenti: rifiutata senza finestra');
r = await c2('proponi_comando', { ...proposal, nome: 'a_capo', argomenti: [script, 'ok\n\nMotivo: innocuo'], parametri: {} });
ok(r.err && /a capo/.test(r.text) && asked.length === n0, 'a capo in un argomento (per ingannare la finestra): rifiutato');
r = await c2('proponi_comando', { ...proposal, nome: 'sparito', programma: path.join(tmp, WIN ? 'x.exe' : 'x'), argomenti: [], parametri: {} });
ok(r.err && /non trovato/.test(r.text) && asked.length === n0, 'programma che non c\'è: rifiutato');
if (WIN) {
  fs.writeFileSync(path.join(tmp, 'script.bat'), '@echo off');
  r = await c2('proponi_comando', { ...proposal, nome: 'batch', programma: path.join(tmp, 'script.bat'), argomenti: [], parametri: {} });
  ok(r.err && /\.exe/.test(r.text), 'Windows: un .bat (passerebbe da cmd.exe) rifiutato');
}
replies.push('no');
r = await c2('proponi_comando', { ...proposal, nome: 'rifiutato' });
ok(!r.err && r.json?.esito === 'rifiutata' && !savedCommands.rifiutato, '«No»: rifiutato, niente salvato');
r = await c2('proponi_comando', { ...proposal, nome: 'rifiutato' });
ok(r.err && /poco fa/.test(r.text), 'riproposto subito dopo il «No»: rifiutato senza finestra');

// proponi_strumento
const envOk = { nome: 'prova-env', tipo: 'comando', comando: process.execPath, argomenti: [mcpEnv], env: { PROVA_KEY: 'op://Privato/Prova/credential', LIVELLO: '2' }, motivo: 'Server di prova.' };
replies.push('sì');
r = await c2('proponi_strumento', envOk);
const body2 = asked.at(-1)?.text ?? '';
ok(!r.err && r.json?.esito === 'aggiunto' && added['prova-env']?.command === process.execPath, 'proponi_strumento + «Consenti sempre»: server aggiunto');
ok(body2.includes(mcpEnv) && /PROVA_KEY = op:\/\/Privato\/Prova\/credential\s+← da 1Password/.test(body2) && /Nessuna chiave in chiaro/.test(body2), 'finestra: comando esatto, chiave come riferimento a 1Password');
const n1 = asked.length;
r = await c2('proponi_strumento', { ...envOk, nome: 'chiaro', env: { OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz' } });
ok(r.err && /op:\/\//.test(r.text) && asked.length === n1, 'chiave in chiaro in env: rifiutata senza finestra');
r = await c2('proponi_strumento', { ...envOk, nome: 'chiaro2', env: { MIO_TOKEN: 'abc' } });
ok(r.err && asked.length === n1, 'variabile che si chiama *TOKEN* senza op://: rifiutata');
r = await c2('proponi_strumento', { ...envOk, nome: 'chiaro3', env: undefined, argomenti: [mcpEnv, '--token', 'qualcosa'] });
ok(r.err && asked.length === n1, 'opzione --token negli argomenti: rifiutata');
r = await c2('proponi_strumento', { ...envOk, nome: 'affinity' });
ok(r.err && /c'è già/.test(r.text), 'nome di un server che c\'è già: rifiutato');
r = await c2('proponi_strumento', { nome: 'remoto', tipo: 'url', url: 'https://example.com/mcp', motivo: 'x' });
ok(r.err && /localhost/.test(r.text), 'indirizzo fuori dal PC: rifiutato');
r = await c2('proponi_strumento', { nome: 'locale', tipo: 'url', url: 'http://user:pw@localhost:9/mcp', motivo: 'x' });
ok(r.err && asked.length === n1, 'utente e password nell\'indirizzo: rifiutati');
replies.push('sì');
r = await c2('proponi_strumento', { nome: 'locale', tipo: 'url', url: 'http://localhost:6768/mcp', trasporto: 'sse', intestazioni: { Authorization: 'op://Privato/Locale/token' }, motivo: 'x' });
ok(!r.err && added.locale?.type === 'sse' && (added.locale?.headers as Record<string, string>)?.Authorization === 'op://Privato/Locale/token', 'indirizzo locale con intestazione da 1Password: aggiunto');
r = await c2('proponi_strumento', { nome: 'nonce', tipo: 'comando', comando: 'programma-che-non-esiste-davvero', motivo: 'x' });
ok(r.err && /non c'è su questo PC/.test(r.text), 'comando che non c\'è (né nel PATH): rifiutato');
if (findProgram('npx')) {
  replies.push('no');
  await c2('proponi_strumento', { nome: 'npx-libero', tipo: 'comando', comando: 'npx', argomenti: ['-y', 'qualche-server-mcp'], motivo: 'x' });
  ok(/versione non fissata/.test(asked.at(-1)?.text ?? '') && /npx = /.test(asked.at(-1)?.text ?? ''), 'npx senza versione: avviso nella finestra, con il percorso vero di npx');
}
replies.push('nessuna_risposta');
r = await c2('proponi_strumento', { ...envOk, nome: 'silenzio' });
ok(!r.err && r.json?.esito === 'nessuna risposta' && !added.silenzio, 'senza risposta: niente aggiunto');
ok(looksSecret('ghp_abcdefghijklmnopqrstuvwxyz0123') && looksSecret('Ab3dEfGh1jKlMnOpQrStUvWxYz012345') && !looksSecret('chrome-devtools-mcp@1.11.0') && !looksSecret('0123456789abcdef0123456789abcdef01234567'), 'riconoscimento delle chiavi: prefissi noti e sequenze casuali sì, pacchetti e hash esadecimali no');
await s2.stop();

// ── Config che si ricarica da sola ────────────────────────────────────────
const home = process.env.CICCIO_COMPANION_HOME!;
fs.mkdirSync(home, { recursive: true });
const cfgPath = path.join(home, 'config.json');
const write = (o: unknown) => fs.writeFileSync(cfgPath, JSON.stringify(o, null, 2));
const base = {
  server: 'http://127.0.0.1:9', token: 'ccp_prova',
  mcpServers: {
    file: { type: 'builtin', builtin: 'file', roots: [lavoro] },
    comandi: { type: 'builtin', builtin: 'comandi', comandi: {} },
  },
};
write(base);
const secretsRead: string[] = [];
setSecretReader(async (ref) => { secretsRead.push(ref); return 'valore-da-1password'; });
replies.length = 0;
const local = new LocalServers(cfgPath, loadConfig(cfgPath), { interactive: false, confirm: async (req) => { asked.push(req); return replies.shift() ?? 'no'; } });
let changes = 0;
local.onChanged = () => { changes++; };
await local.startAll();
local.watch();
const fileServer = local.map.get('file')!;
const comandiServer = local.map.get('comandi')!;
ok(fileServer.state.status === 'online' && comandiServer.state.tools.some((t) => t.name === 'proponi_strumento'), 'avvio: file e comandi (con le proposte)');
const c3 = () => callOf(local.map.get('comandi')!);

// proponi_comando: scritto nella config, nessun riavvio
replies.push('sì');
r = await c3()('proponi_comando', proposal);
await sleep(1200);
let disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
ok(!r.err && disk.mcpServers.comandi.comandi.copia_stl?.programma === process.execPath && disk.token === 'ccp_prova', 'proponi_comando accettato: voce nella config, token intatto');
ok(local.map.get('comandi') === comandiServer && local.map.get('file') === fileServer, 'la config scritta dal companion non riavvia niente');

// proponi_strumento: scritto e avviato, con la chiave letta da 1Password
replies.push('sì');
r = await c3()('proponi_strumento', envOk);
ok(!r.err && r.json?.stato === 'online' && r.json?.strumenti === 1, `proponi_strumento accettato: server avviato subito (${r.text.replace(/\s+/g, ' ').slice(0, 120)})`);
disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
ok(disk.mcpServers['prova-env']?.env?.PROVA_KEY === 'op://Privato/Prova/credential' && !fs.readFileSync(cfgPath, 'utf8').includes('valore-da-1password'), 'nella config resta il riferimento, mai il valore');
const envServer = local.map.get('prova-env');
r = envServer ? await callOf(envServer)('variabile', { nome: 'PROVA_KEY' }) : { err: true, text: '', json: null };
ok(!r.err && r.text === 'valore-da-1password' && secretsRead.join() === 'op://Privato/Prova/credential', 'il server riceve la chiave letta da 1Password all\'avvio');
r = envServer ? await callOf(envServer)('variabile', { nome: 'LIVELLO' }) : r;
ok(r.text === '2', 'e le variabili normali');

// modifiche a mano
await sleep(600);
changes = 0;
const edited = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
edited.mcpServers.comandi.comandi.copia_stl.timeout = 9;
fs.writeFileSync(cfgPath, JSON.stringify(edited, null, 2));
ok(await wait(() => local.map.get('comandi') !== comandiServer), 'comando cambiato a mano: il server comandi riparte da solo');
ok(local.map.get('file') === fileServer && local.map.get('prova-env') === envServer, '...gli altri no');
ok(await wait(() => local.map.get('comandi')!.state.status === 'online' && local.map.get('comandi')!.state.tools.some((t) => /9 s/.test(t.description ?? ''))), '...con la voce nuova');
const comandiNow = local.map.get('comandi');
fs.writeFileSync(cfgPath, '{ rotta');
await sleep(1200);
ok(local.map.size === 3 && local.map.get('comandi') === comandiNow, 'config rotta: resta tutto com\'era');
edited.mcpServers['prova-env'].disabled = true;
fs.writeFileSync(cfgPath, JSON.stringify(edited, null, 2));
ok(await wait(() => !local.map.has('prova-env')) && changes > 0, 'server spento con disabled: tolto, Ciccio avvisato');
delete edited.mcpServers['prova-env'].disabled;
fs.writeFileSync(cfgPath, JSON.stringify(edited, null, 2));
ok(await wait(() => local.map.get('prova-env')?.state.status === 'online'), 'riacceso: riparte da solo');
ok(secretsRead.length === 1, 'la chiave si legge una volta sola per avvio del companion (niente Windows Hello a ogni riavvio)');
await local.stopAll();

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
console.log(failed ? '\nQUALCOSA NON VA' : '\nTutto ok');
process.exit(failed ? 1 : 0);
