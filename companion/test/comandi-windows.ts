// Prova sul desktop di Windows, con le finestre vere, del companion compilato: Ciccio (solo la parte companion)
// in questo processo e una sessione come quella di un agente con il repo del suo progetto.
//  1. scarica_da_ciccio: un STL del repo finisce sul Desktop del PC;
//  2. proponi_comando: lo slicer di Bambu Studio (se c'è; altrimenti certutil, innocuo) → finestra → «Consenti sempre»;
//  3. il comando nuovo affetta l'STL e scrive il 3MF; 4. carica_su_ciccio: il 3MF torna nel repo;
//  5. proponi_strumento: un server MCP locale di prova → «Consenti sempre» → parte senza riavvii e risponde;
//  6. da tastiera la finestra dà solo «No»; 7. la config cambiata a mano si ricarica da sola.
// Serve un desktop acceso: le finestre compaiono davvero e la prova le clicca col mouse.
//
//   pnpm exec tsx companion/test/comandi-windows.ts dist\companion\ciccio-companion-windows-x64.exe [--foto <cartella>]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') { console.log('Prova solo per Windows.'); process.exit(0); }
const exe = path.resolve(process.argv[2] ?? '');
if (!fs.existsSync(exe)) { console.error(`Binario non trovato: ${exe}`); process.exit(2); }
const shotsArg = process.argv.indexOf('--foto');
const shots = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-comandi-win-')));
process.env.CICCIO_DATA_DIR = path.join(tmp, 'data');
const home = path.join(tmp, 'companion home');
const env = { ...process.env, CICCIO_COMPANION_HOME: home };
const cfgPath = path.join(home, 'config.json');
const repo = path.join(tmp, 'progetti', 'pezzo-prova');
const stampe = path.join(tmp, 'Desktop', 'stampe 3D');
const lavoro = path.join(tmp, 'lavoro bambu');
for (const d of [path.join(repo, 'out'), stampe, lavoro]) fs.mkdirSync(d, { recursive: true });

// Un cubo di 20 mm in STL ASCII, come lo farebbe OpenSCAD sul server.
function cube(s: number): string {
  const P = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const f: string[] = [];
  const tri = (a: number[], b: number[], c: number[]) => f.push(`facet normal 0 0 0\nouter loop\n${[a, b, c].map((v) => `vertex ${v.join(' ')}`).join('\n')}\nendloop\nendfacet`);
  for (const [a, b, c, d] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) { tri(P[a], P[b], P[c]); tri(P[a], P[c], P[d]); }
  return `solid cubo\n${f.join('\n')}\nendsolid cubo\n`;
}
fs.writeFileSync(path.join(repo, 'out', 'cubo.stl'), cube(20));

const bambu = 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe';
const prof = 'C:\\Program Files\\Bambu Studio\\resources\\profiles\\BBL';
const hasBambu = fs.existsSync(bambu) && fs.existsSync(path.join(prof, 'machine', 'Bambu Lab P1S 0.4 nozzle.json'));
// Bambu Studio vuole stampante, processo e filamento (senza va in crash): profili di sistema della P1S.
const command = hasBambu
  ? {
      nome: 'bambu_slice', descrizione: 'Affetta un modello per la Bambu Lab P1S (0.4, 0.20 mm Standard, PLA Basic) e salva il 3MF con il G-code.',
      programma: bambu,
      argomenti: ['--load-settings', `${prof}\\machine\\Bambu Lab P1S 0.4 nozzle.json;${prof}\\process\\0.20mm Standard @BBL X1C.json`, '--load-filaments', `${prof}\\filament\\Bambu PLA Basic @BBL X1C.json`, '--slice', '0', '--export-3mf', '{uscita}', '{modello}'],
      parametri: { modello: { tipo: 'file', estensioni: ['.stl', '.3mf', '.obj', '.step'] }, uscita: { tipo: 'uscita', estensioni: ['.3mf'] } },
      timeout: 600, cartella: lavoro,
    }
  : {
      nome: 'codifica', descrizione: 'Codifica un file in base64 (certutil).',
      programma: 'C:\\Windows\\System32\\certutil.exe',
      argomenti: ['-encode', '{modello}', '{uscita}'],
      parametri: { modello: { tipo: 'file' }, uscita: { tipo: 'uscita', estensioni: ['.3mf'] } },
      timeout: 60, cartella: lavoro,
    };

const { default: Fastify } = await import('fastify');
const { default: websocket } = await import('@fastify/websocket');
const { registerCompanion, pcMcpServers, companions, releasePcServers, pcToolHints } = await import('../../server/src/companion.js');
const { decide } = await import('../../server/src/policy.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

let failed = false;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failed = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (f: () => boolean, ms: number) => { for (const t0 = Date.now(); !f(); ) { if (Date.now() - t0 > ms) return false; await sleep(250); } return true; };
const sha = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// UI Automation e mouse, come in access-windows.ts: trova la finestra di Ciccio Companion che mostra `contains`,
// poi (facoltativo) foto, tasti e pulsante da premere. Risponde con una riga: ok, assente o un errore.
const UIA_PS1 = String.raw`
param([string]$Contains, [string]$Button, [string]$Shot, [string]$Keys, [int]$Seconds)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type -Namespace CcTest -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);'
[void][CcTest.U]::SetProcessDPIAware()
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]
$byName = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, 'Ciccio Companion')
$deadline = (Get-Date).AddSeconds($Seconds)
$win = $null
while (-not $win -and (Get-Date) -lt $deadline) {
  foreach ($w in $A::RootElement.FindAll($T::Children, $byName)) {
    foreach ($e in $w.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($e.Current.Name -like "*$Contains*") { $win = $w; break }
    }
    if ($win) { break }
  }
  if (-not $win) { Start-Sleep -Milliseconds 300 }
}
if (-not $win) { [Console]::Out.Write('assente'); exit 0 }
Start-Sleep -Milliseconds 1300
if ($Shot) {
  $r = $win.Current.BoundingRectangle
  $bmp = New-Object System.Drawing.Bitmap ([int]$r.Width), ([int]$r.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size)
  $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
}
function Find-Named($name) {
  foreach ($e in $win.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if ($e.Current.Name -eq $name) { return $e } }
  throw "non trovato: $name"
}
function Click($e) {
  $r = $e.Current.BoundingRectangle
  [void][CcTest.U]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
  Start-Sleep -Milliseconds 100
  [CcTest.U]::mouse_event(2, 0, 0, 0, 0); [CcTest.U]::mouse_event(4, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 300
}
if ($Keys) {
  $r = $win.Current.BoundingRectangle
  [void][CcTest.U]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + 12))
  [CcTest.U]::mouse_event(2, 0, 0, 0, 0); [CcTest.U]::mouse_event(4, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
}
if ($Button) { Click (Find-Named $Button) }
[Console]::Out.Write('ok')
`;
const uiaFile = path.join(tmp, 'uia.ps1');
fs.writeFileSync(uiaFile, `﻿${UIA_PS1.trim()}\r\n`);
const uia = async (contains: string, o: { button?: string; shot?: string; keys?: string; seconds?: number } = {}) => {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', uiaFile, '-Contains', contains,
    '-Button', o.button ?? '', '-Shot', o.shot && shots ? path.join(shots, o.shot) : '', '-Keys', o.keys ?? '', '-Seconds', String(o.seconds ?? 30)];
  let out: string;
  try { out = (await promisify(execFile)('powershell', args, { encoding: 'utf8' })).stdout.trim(); } catch (e) { out = `errore: ${(e as Error).message.split('\n').slice(-4).join(' ')}`; }
  if (out !== 'ok' && out !== 'assente') console.log(`  UI Automation: ${out}`);
  return out;
};

const app = Fastify();
await app.register(websocket);
registerCompanion(app);
await app.listen({ host: '127.0.0.1', port: 0 });
const port = (app.server.address() as { port: number }).port;
const created = (await app.inject({ method: 'POST', url: '/api/companions', payload: { name: 'prova' } })).json() as { token: string };

fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify({
  server: `http://127.0.0.1:${port}`, token: created.token, notifications: false,
  mcpServers: {
    file: { type: 'builtin', builtin: 'file', roots: [stampe] },
    comandi: { type: 'builtin', builtin: 'comandi', comandi: {} },
  },
}, null, 2));

const child = spawn(exe, ['run', '--background', '--config', cfgPath], { env, stdio: 'inherit' });
const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
const live = (name: string) => companions().find((x) => x.name === 'prova')?.servers.find((s) => s.name === name);
const online = await wait(() => live('file')?.status === 'online' && live('comandi')?.status === 'online', 60_000);
ok(online, 'companion collegato con i server file e comandi');

type Res = { isError?: boolean; content: { type: string; text?: string }[] };
const textOf = (r: Res) => r.content.map((c) => c.text ?? '').join('');
const jsonOf = (r: Res) => { try { return JSON.parse(textOf(r)) as Record<string, any>; } catch { return {}; } };
const oneLine = (r: Res) => textOf(r).replace(/\s+/g, ' ').slice(0, 220);
async function session() {
  const servers = pcMcpServers({ repoDir: repo, who: 'pezzo-prova / prova' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await servers.pc_prova.instance.connect(b);
  const client = new Client({ name: 'prova', version: '1' });
  await client.connect(a);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 }) as Promise<Res>;
  return { client, call, close: async () => { await client.close(); releasePcServers(servers); } };
}

if (online) {
  let s = await session();
  const names = (await s.client.listTools()).tools.map((t) => t.name);
  ok(['file_scarica_da_ciccio', 'file_carica_su_ciccio', 'comandi_proponi_comando', 'comandi_proponi_strumento'].every((n) => names.includes(n)), 'strumenti nuovi esposti a Ciccio: scarica/carica, proponi_comando, proponi_strumento');

  // 1. Dal repo al PC
  const stl = path.join(stampe, 'cubo.stl');
  let r = await s.call('file_scarica_da_ciccio', { file_sul_server: 'out/cubo.stl', destinazione: stl });
  ok(!r.isError && fs.existsSync(stl) && sha(stl) === sha(path.join(repo, 'out', 'cubo.stl')), `scarica_da_ciccio: l'STL del repo è sul Desktop · ${oneLine(r)}`);

  // 2. proponi_comando → finestra vera → «Consenti sempre»
  const call = s.call('comandi_proponi_comando', { ...command, motivo: 'Per affettare i modelli fatti con OpenSCAD e mandarli alla P1S.' });
  ok(await uia(command.nome, { shot: '1-proponi-comando.png', button: 'Consenti sempre' }) === 'ok', `finestra con ${path.basename(command.programma)} e gli argomenti; premuto «Consenti sempre»`);
  r = await call;
  ok(!r.isError && jsonOf(r).esito === 'consentito', `risposta all'agente: ${oneLine(r)}`);
  const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(saved.token === created.token && saved.mcpServers.comandi.comandi[command.nome]?.programma === command.programma, 'config del PC: comando aggiunto, token intatto');
  ok(await wait(() => !!live('comandi')?.tools.some((t) => t.name === command.nome), 20_000), `Ciccio vede subito lo strumento ${command.nome}, senza Ricollega`);
  const exposed = `mcp__pc_prova__comandi_${command.nome}`;
  ok(decide('auto', exposed, {}, repo, pcToolHints(exposed)).action === 'ask', 'in automatico il comando chiede il permesso (è un\'azione sul PC)');
  await s.close();
  s = await session();

  // 3. Il comando sul file scaricato
  const out3mf = path.join(stampe, 'cubo.3mf');
  const t0 = Date.now();
  r = await s.call(`comandi_${command.nome}`, { modello: stl, uscita: out3mf });
  ok(!r.isError && jsonOf(r).codice === 0 && fs.existsSync(out3mf) && fs.statSync(out3mf).size > 1000, `${command.nome} in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${fs.existsSync(out3mf) ? fs.statSync(out3mf).size : 0} byte · ${oneLine(r)}`);
  if (hasBambu) {
    const listing = execFileSync('C:\\Windows\\System32\\tar.exe',['-tf', out3mf], { encoding: 'utf8' });
    ok(/Metadata\/plate_1\.gcode/.test(listing), 'il 3MF contiene il G-code della piastra 1');
  }
  r = await s.call(`comandi_${command.nome}`, { modello: stl, uscita: out3mf });
  ok(r.isError && /esiste già/.test(textOf(r)), 'seconda volta sulla stessa uscita: rifiutata (niente sovrascrittura)');
  r = await s.call(`comandi_${command.nome}`, { modello: path.join(repo, 'out', 'cubo.stl'), uscita: path.join(stampe, 'x.3mf') });
  ok(r.isError && /fuori dalle cartelle consentite/.test(textOf(r)), 'modello fuori dalle cartelle consentite del PC: rifiutato');

  // 4. Dal PC al repo
  r = await s.call('file_carica_su_ciccio', { file_sul_pc: out3mf, destinazione_sul_server: 'stampe/cubo.3mf' });
  ok(!r.isError && sha(path.join(repo, 'stampe', 'cubo.3mf')) === sha(out3mf), `carica_su_ciccio: il 3MF è nel repo · ${oneLine(r)}`);

  // 5. proponi_strumento → «Consenti sempre» → il server parte da solo
  const node = execFileSync('where.exe', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  const call2 = s.call('comandi_proponi_strumento', { nome: 'prova-env', tipo: 'comando', comando: node, argomenti: [path.join(here, 'fixtures', 'mcp-env.mjs')], env: { LIVELLO: '7' }, motivo: 'Server MCP di prova per vedere le variabili.' });
  ok(await uia('prova-env', { shot: '2-proponi-strumento.png', button: 'Consenti sempre' }) === 'ok', 'finestra con il comando esatto del server; premuto «Consenti sempre»');
  r = await call2;
  ok(!r.isError && jsonOf(r).esito === 'aggiunto' && jsonOf(r).stato === 'online' && jsonOf(r).strumenti === 1, `risposta all'agente: ${oneLine(r)}`);
  ok(await wait(() => live('prova-env')?.status === 'online', 20_000), 'Ciccio vede il server nuovo, senza Ricollega');
  await s.close();
  s = await session();
  r = await s.call('prova-env_variabile', { nome: 'LIVELLO' });
  ok(!r.isError && textOf(r) === '7', 'lo strumento del server nuovo risponde dal PC');

  // 6. Da tastiera solo «No»
  const call3 = s.call('comandi_proponi_comando', { ...command, nome: 'da_tastiera', motivo: 'Prova della tastiera.' });
  ok(await uia('da_tastiera', { shot: '3-tastiera.png', keys: '{TAB}{TAB}{TAB} ' }) === 'ok', 'finestra comparsa; premuti Tab e spazio');
  r = await call3;
  ok(!r.isError && jsonOf(r).esito === 'rifiutata' && !JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers.comandi.comandi.da_tastiera, `da tastiera solo «No»: ${oneLine(r)}`);

  // 7. Config cambiata a mano: il server si spegne da solo
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.mcpServers['prova-env'].disabled = true;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  ok(await wait(() => !live('prova-env'), 15_000), 'disabled scritto a mano nella config: il server sparisce dal PC, senza Ricollega');
  await s.close();

  const log = fs.readFileSync(path.join(home, 'companion.log'), 'utf8');
  ok(/config ricaricata · aggiunti prova-env/.test(log) && /config ricaricata · tolti prova-env/.test(log) && !log.includes(created.token), 'registro: ricariche della config, mai il token');
}

const stopOut = execFileSync(exe, ['stop'], { env, encoding: 'utf8' });
const code = await Promise.race([exited, sleep(20_000).then(() => 'timeout')]);
ok(/chiuso/.test(stopOut) && code === 0, `companion chiuso (codice ${code})`);
await app.close();
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { console.log(`(cartella temporanea non tolta: ${(e as Error).message})`); }
console.log(failed ? '\nPROVA FALLITA' : '\nPROVA RIUSCITA');
process.exit(failed ? 1 : 0);
