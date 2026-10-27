// Prova di chiedi_accesso sul desktop di Windows, con la finestra vera: Ciccio (solo la parte companion)
// in questo processo, il companion compilato come processo vero, la finestra di PowerShell cliccata con
// UI Automation come farebbe una persona. «Consenti sempre» (config aggiornata, istruzioni nuove a Ciccio,
// cartella subito utilizzabile in sola lettura), «Consenti questa volta» togliendo la spunta «Solo lettura»,
// «No», chiamata annullata da Ciccio (la finestra si chiude) e, con --attesa, i 3 minuti senza risposta.
// Serve un desktop acceso: la finestra compare davvero (in primo piano) e si chiude da sola.
//
//   pnpm exec tsx companion/test/access-windows.ts dist\companion\ciccio-companion-windows-x64.exe [--attesa] [--foto <cartella>]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'win32') { console.log('Prova solo per Windows.'); process.exit(0); }
const exe = path.resolve(process.argv[2] ?? '');
if (!fs.existsSync(exe)) { console.error(`Binario non trovato: ${exe}`); process.exit(2); }
const fullWait = process.argv.includes('--attesa');
const shotsArg = process.argv.indexOf('--foto');
const shots = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-access-')));
process.env.CICCIO_DATA_DIR = path.join(tmp, 'data');
const home = path.join(tmp, 'companion home');
const env = { ...process.env, CICCIO_COMPANION_HOME: home };
const cfgPath = path.join(home, 'config.json');
const desk = path.join(tmp, 'Desktop', 'affinity');
const onedrive = path.join(tmp, 'OneDrive - Acme s.r.l', 'ACME SRL');
const foto = path.join(onedrive, 'Commerciale', 'Prodotti', 'Sedia', 'Foto');
const altrove = path.join(tmp, 'Archivio foto', '2026');
const bozze = path.join(tmp, 'Bozze grafica');
const no = path.join(tmp, 'Privato');
const lontana = path.join(tmp, 'Lontana');
for (const d of [desk, altrove, bozze, no, lontana]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(foto, { recursive: true });
fs.writeFileSync(path.join(altrove, 'posa.jpg'), 'POSA');
fs.writeFileSync(path.join(foto, 'f1.jpg'), 'F1');

const { default: Fastify } = await import('fastify');
const { default: websocket } = await import('@fastify/websocket');
const { registerCompanion, pcMcpServers, companions, releasePcServers } = await import('../../server/src/companion.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

let failed = false;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failed = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (f: () => boolean, ms: number) => {
  for (const t0 = Date.now(); !f(); ) { if (Date.now() - t0 > ms) return false; await sleep(250); }
  return true;
};

// UI Automation e mouse: trova la finestra di Ciccio Companion che mostra `contains`, poi (facoltativo) foto,
// spunta da togliere e pulsante da premere. Risponde con una riga: ok, assente o un errore.
const UIA_PS1 = String.raw`
param([string]$Contains, [string]$Button, [string]$Shot, [string]$Untick, [string]$Keys, [int]$Seconds)
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
# I consensi si attivano dopo un secondo.
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
# Clic vero del mouse al centro del controllo (i controlli di Windows Forms in PowerShell non espongono Invoke).
function Click($e) {
  $r = $e.Current.BoundingRectangle
  [void][CcTest.U]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
  Start-Sleep -Milliseconds 100
  [CcTest.U]::mouse_event(2, 0, 0, 0, 0); [CcTest.U]::mouse_event(4, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 300
}
# Tasti: prima un clic sulla barra del titolo, che porta la finestra in primo piano senza premere niente.
if ($Keys) {
  $r = $win.Current.BoundingRectangle
  [void][CcTest.U]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + 12))
  [CcTest.U]::mouse_event(2, 0, 0, 0, 0); [CcTest.U]::mouse_event(4, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
}
if ($Untick) { Click (Find-Named $Untick) }
if ($Button) { Click (Find-Named $Button) }
[Console]::Out.Write('ok')
`;
const uiaFile = path.join(tmp, 'uia.ps1');
fs.writeFileSync(uiaFile, `﻿${UIA_PS1.trim()}\r\n`);
const uia = async (contains: string, o: { button?: string; shot?: string; untick?: string; keys?: string; seconds?: number } = {}) => {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', uiaFile, '-Contains', contains,
    '-Button', o.button ?? '', '-Shot', o.shot && shots ? path.join(shots, o.shot) : '', '-Untick', o.untick ?? '', '-Keys', o.keys ?? '', '-Seconds', String(o.seconds ?? 30)];
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
  mcpServers: { file: { type: 'builtin', builtin: 'file', roots: [desk, { path: onedrive, solaLettura: true }] } },
}, null, 2));

const child = spawn(exe, ['run', '--background', '--config', cfgPath], { env, stdio: 'inherit' });
const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
const online = await wait(() => !!companions().find((x) => x.name === 'prova')?.servers.find((s) => s.name === 'file' && s.status === 'online'), 60_000);
ok(online, 'companion collegato con il server file');

/** Un client MCP come quello di una sessione di Ciccio (gli strumenti si chiamano file_*). */
async function session() {
  const servers = pcMcpServers();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await servers.pc_prova.instance.connect(b);
  const client = new Client({ name: 'prova', version: '1' });
  await client.connect(a);
  return { client, close: async () => { await client.close(); releasePcServers(servers); } };
}
type Res = { isError?: boolean; content: { type: string; text?: string }[] };
const textOf = (r: Res) => r.content.map((c) => c.text ?? '').join('');
const jsonOf = (r: Res) => { try { return JSON.parse(textOf(r)) as Record<string, any>; } catch { return {}; } };

if (online) {
  let s = await session();
  const names = (await s.client.listTools()).tools.map((t) => t.name);
  ok(names.includes('file_chiedi_accesso'), 'strumento file_chiedi_accesso esposto a Ciccio');
  ok(/sola lettura/.test(s.client.getInstructions() ?? ''), 'istruzioni per Ciccio: la cartella in sola lettura è indicata');

  // 1. Cartella fuori dalle cartelle consentite, in sola lettura, «Consenti sempre»
  let call = s.client.callTool({ name: 'file_chiedi_accesso', arguments: { cartella: altrove, solaLettura: true, motivo: 'Mi servono le foto di posa per la scheda in Affinity.' } }, undefined, { timeout: 300_000 }) as Promise<Res>;
  ok(await uia(altrove, { shot: '1-richiesta.png', button: 'Consenti sempre' }) === 'ok', 'finestra comparsa sul desktop con la cartella chiesta; premuto «Consenti sempre»');
  let r = await call;
  ok(!r.isError && jsonOf(r).esito === 'consentita' && /sempre/.test(jsonOf(r).valida) && jsonOf(r).solaLettura === true, `risposta all'agente: ${textOf(r).replace(/\s+/g, ' ')}`);
  const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(saved.token === created.token && saved.mcpServers.file.roots.some((x: any) => x.path === altrove && x.solaLettura === true), 'config del PC: cartella aggiunta in sola lettura, token intatto');
  r = await s.client.callTool({ name: 'file_copia', arguments: { da: path.join(altrove, 'posa.jpg'), a: path.join(desk, 'posa.jpg') } }) as Res;
  ok(!r.isError && fs.readFileSync(path.join(desk, 'posa.jpg'), 'utf8') === 'POSA', 'subito utilizzabile, senza riavviare il companion: copia sul Desktop');
  r = await s.client.callTool({ name: 'file_copia', arguments: { da: path.join(desk, 'posa.jpg'), a: path.join(altrove, 'copia.jpg') } }) as Res;
  ok(r.isError && /sola lettura/.test(textOf(r)) && !fs.existsSync(path.join(altrove, 'copia.jpg')), 'in sola lettura: scrittura rifiutata');
  r = await s.client.callTool({ name: 'file_copia', arguments: { da: path.join(foto, 'f1.jpg'), a: path.join(desk, 'f1.jpg') } }) as Res;
  ok(!r.isError, 'cartella OneDrive in sola lettura della config: copia verso il Desktop');
  await s.close();
  s = await session();
  ok((s.client.getInstructions() ?? '').includes(altrove), 'istruzioni nuove arrivate a Ciccio (nuova sessione)');

  // 2. «Consenti questa volta» togliendo «Solo lettura»: anche in scrittura, config invariata
  const before = fs.readFileSync(cfgPath, 'utf8');
  call = s.client.callTool({ name: 'file_chiedi_accesso', arguments: { cartella: bozze, solaLettura: true, motivo: 'Copiare qui le bozze esportate.' } }, undefined, { timeout: 300_000 }) as Promise<Res>;
  ok(await uia(bozze, { shot: '2-solo-lettura-tolta.png', untick: 'Solo lettura (copiare da qui, non scriverci)', button: 'Consenti questa volta' }) === 'ok', 'tolta la spunta «Solo lettura», premuto «Consenti questa volta»');
  r = await call;
  ok(!r.isError && jsonOf(r).esito === 'consentita' && jsonOf(r).solaLettura === false && /fino alle/.test(jsonOf(r).valida), `risposta all'agente: ${textOf(r).replace(/\s+/g, ' ')}`);
  ok(fs.readFileSync(cfgPath, 'utf8') === before, '«questa volta»: config invariata');
  r = await s.client.callTool({ name: 'file_copia', arguments: { da: path.join(desk, 'posa.jpg'), a: path.join(bozze, 'posa.jpg') } }) as Res;
  ok(!r.isError && fs.existsSync(path.join(bozze, 'posa.jpg')), 'concessa anche in scrittura: copia dentro ok');

  // 3. Da tastiera (come chi stava scrivendo altrove): Tab, spazio e Invio non concedono niente, danno «No»
  call = s.client.callTool({ name: 'file_chiedi_accesso', arguments: { cartella: no, solaLettura: true, motivo: 'Curiosità.' } }, undefined, { timeout: 300_000 }) as Promise<Res>;
  ok(await uia(no, { shot: '3-tastiera.png', keys: '{TAB}{TAB}{TAB}{TAB} ' }) === 'ok', 'finestra comparsa; premuti Tab quattro volte e spazio');
  r = await call;
  ok(!r.isError && jsonOf(r).esito === 'rifiutata', `da tastiera solo «No»: ${textOf(r).replace(/\s+/g, ' ')}`);
  r = await s.client.callTool({ name: 'file_chiedi_accesso', arguments: { cartella: no, solaLettura: true, motivo: 'Di nuovo.' } }) as Res;
  ok(r.isError && /poco fa/.test(textOf(r)), 'richiesta ripetuta subito: rifiutata senza finestra');

  // 4. Chiamata annullata da Ciccio (es. Stop nella chat): la finestra si chiude da sola
  const ctrl = new AbortController();
  call = s.client.callTool({ name: 'file_chiedi_accesso', arguments: { cartella: lontana, solaLettura: true, motivo: 'Annullata.' } }, undefined, { timeout: 300_000, signal: ctrl.signal }) as Promise<Res>;
  call.catch(() => undefined);
  ok(await uia(lontana, { seconds: 30 }) === 'ok', 'finestra comparsa');
  ctrl.abort();
  await sleep(3000);
  ok(await uia(lontana, { seconds: 2 }) === 'assente', 'chiamata annullata: la finestra sul PC si è chiusa');
  await sleep(1000);

  // 5. Con --attesa: nessuno risponde per 3 minuti
  if (fullWait) {
    const t0 = Date.now();
    r = await s.client.callTool({ name: 'file_chiedi_accesso', arguments: { cartella: lontana, solaLettura: true, motivo: 'Nessuno risponde.' } }, undefined, { timeout: 300_000 }) as Res;
    ok(!r.isError && jsonOf(r).esito === 'nessuna risposta' && Date.now() - t0 >= 179_000, `dopo ${Math.round((Date.now() - t0) / 1000)} s: ${textOf(r).replace(/\s+/g, ' ')}`);
    ok(await uia(lontana, { seconds: 2 }) === 'assente', 'scaduto il tempo: la finestra si è chiusa');
  }
  await s.close();
  const log = fs.readFileSync(path.join(home, 'companion.log'), 'utf8');
  ok(/accesso · .*consentita sempre/.test(log) && /accesso · .*rifiutata/.test(log) && !log.includes(created.token), 'registro: richieste e risposte, mai il token');
}

const stopOut = execFileSync(exe, ['stop'], { env, encoding: 'utf8' });
const code = await Promise.race([exited, sleep(20_000).then(() => 'timeout')]);
ok(/chiuso/.test(stopOut) && code === 0, `companion chiuso (codice ${code})`);
await app.close();
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { console.log(`(cartella temporanea non tolta: ${(e as Error).message})`); }
console.log(failed ? '\nPROVA FALLITA' : '\nPROVA RIUSCITA');
process.exit(failed ? 1 : 0);
