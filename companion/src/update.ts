import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { COMPANION_DOWNLOAD_PATH, newerVersion, type UpdateParams } from '../../shared/companion.js';
import { checkSignedFile, NO_RELEASE_KEY, openManifest, releaseKeys, type SignedFile } from '../../shared/node/release.js';
import { spawn } from 'node:child_process';
import { configDir, defaultConfigPath, VERSION } from './config.js';
import { clearHandoff, requestStop, waitHandoff } from './instance.js';
import { backgroundExe, consoleExe } from './service.js';
import { withoutConsole } from './pe.js';
import { dim, green, log, red } from './log.js';
import { setStatus } from './status.js';

// Aggiornamento automatico, senza complicazioni: Ciccio dice che c'è una versione nuova
// (companion/update) con il manifest firmato; il companion controlla la firma con la chiave pubblica delle
// release che ha dentro (shared/release-key.ts), scarica il file dal server con il suo token, controlla
// dimensione, sha256 e firma del file e solo allora lo passa a chi lo installa:
// - Mac: l'app della barra dei menu (legge "update" in status.json, sostituisce l'app e riparte);
// - Windows: installWindows() qui sotto.
// Si installa solo quando non ci sono chiamate agli strumenti in corso. Il server non basta: anche un Ciccio
// compromesso non può far installare ai PC un programma che non sia di una release firmata.

export const updatesDir = () => path.join(configDir(), 'updates');

/** Gira dentro Ciccio Companion.app (Mac)? Solo lì c'è chi sostituisce l'app. */
const insideMacApp = () => process.platform === 'darwin' && process.execPath.includes('.app/Contents/Resources/');
const compiled = () => !/^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath));
/** Windows: companion avviato dall'icona nell'area di notifica (tray.ts), che lo aggiorna lei. */
export const underTray = () => process.platform === 'win32' && process.env.CICCIO_COMPANION_TRAY === '1';

export class Updater {
  /** Versione in lavorazione o già pronta: le offerte successive della stessa versione si ignorano. */
  private handled: string | null = null;

  constructor(private serverUrl: string, private token: string, private busy: () => boolean) {}

  offer(u: UpdateParams) {
    if (!newerVersion(u.version, VERSION) || this.handled === u.version) return;
    if (!releaseKeys().length) {
      // Compilato senza la chiave pubblica (segnaposto): mai un aggiornamento non controllato.
      this.handled = u.version;
      log(`${red('✗')} c'è la versione ${u.version} del companion, ma ${NO_RELEASE_KEY}`);
      return;
    }
    if (!compiled() || (process.platform === 'darwin' && !insideMacApp())) {
      this.handled = u.version;
      log(dim(`c'è la versione ${u.version} del companion (questa è ${VERSION}): da qui si aggiorna a mano`));
      return;
    }
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    this.handled = u.version;
    void this.run(u).catch((err: Error) => {
      // Al prossimo collegamento (o tra 10 minuti) Ciccio la riofre e si riprova.
      this.handled = null;
      log(`${red('✗')} aggiornamento ${u.version} non riuscito: ${err.message}`);
    });
  }

  private async run(u: UpdateParams) {
    // Il file giusto lo dice il manifest firmato, non il resto del messaggio del server.
    const keys = releaseKeys();
    const m = openManifest(u.manifest ?? '', u.signature ?? '', keys, 'companion');
    if (m.version !== u.version) throw new Error(`il manifest firmato è della versione ${m.version}, non della ${u.version}`);
    const entry = m.files[`${os.platform()}-${os.arch()}`];
    if (!entry) throw new Error(`la release ${m.version} non ha un file per ${os.platform()}-${os.arch()}`);
    log(`↓ scarico la versione ${u.version} del companion ${dim('(manifest firmato)')}`);
    const file = await this.download(entry);
    // Mai a metà di una chiamata: si aspetta che gli strumenti siano fermi (al massimo 10 minuti).
    for (let i = 0; i < 120 && this.busy(); i++) await new Promise((r) => setTimeout(r, 5000));
    log(`${green('●')} versione ${u.version} pronta, la installo`);
    // Mac (app della barra dei menu) e Windows con l'icona: installa chi tiene acceso il companion.
    if (process.platform === 'darwin' || underTray()) setStatus({ update: { version: u.version, path: file } });
    else await installWindows(file, u.version);
  }

  /** Scarica in updates/<file> (prima .part), controllando dimensione, sha256 e firma della voce del manifest. */
  private async download(entry: SignedFile): Promise<string> {
    const keys = releaseKeys();
    fs.mkdirSync(updatesDir(), { recursive: true });
    const dest = path.join(updatesDir(), entry.file);
    // Già scaricato da un tentativo precedente: si ricontrolla tutto, firma compresa.
    if (fs.existsSync(dest)) {
      try { checkSignedFile(fs.readFileSync(dest), entry, keys); return dest; } catch { fs.rmSync(dest, { force: true }); }
    }
    const res = await fetch(new URL(`${COMPANION_DOWNLOAD_PATH}/${entry.file}`, this.serverUrl), { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`il server ha risposto HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    checkSignedFile(data, entry, keys);
    const part = `${dest}.part`;
    fs.writeFileSync(part, data, { mode: 0o600 });
    fs.renameSync(part, dest);
    return dest;
  }
}

// ── Windows ─────────────────────────────────────────────────────────────
// Le copie installate stanno in %USERPROFILE%\.ciccio-companion\bin (vedi windowsCopies in service.ts).
// Un .exe in esecuzione non si può sovrascrivere né cancellare, ma si può rinominare: le copie vecchie
// diventano .old, le nuove prendono il loro nome, parte il companion nuovo in background e questo si chiude.
// Se il nuovo non dà segni di vita entro 20 s si rimettono le copie vecchie e si resta come prima.

const HANDOFF_MS = 20_000;

/** Windows: sostituisce le copie in bin con la versione scaricata e passa la mano al companion nuovo. */
async function installWindows(file: string, version: string): Promise<void> {
  const self = path.resolve(process.execPath).toLowerCase();
  const copies = [consoleExe(), backgroundExe()];
  if (!copies.some((c) => path.resolve(c).toLowerCase() === self)) {
    // Lanciato da un .exe scaricato, non installato: come il Mac da terminale, si dice e basta.
    log(dim(`versione ${version} scaricata in ${file}: questo .exe non è installato, per aggiornarlo fai doppio clic sul file scaricato`));
    return;
  }
  let swapped: Swapped;
  try { swapped = swapBinaries(file); } catch (err) { throw new Error(`sostituzione dell'.exe non riuscita: ${(err as Error).message}`); }

  clearHandoff();
  const configPath = configArg() ?? defaultConfigPath();
  spawn(backgroundExe(), ['run', '--background', '--config', configPath, '--replaces', String(process.pid)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const pid = await waitHandoff(version, HANDOFF_MS);
  if (!pid) {
    restoreBinaries(swapped);
    throw new Error(`la versione ${version} non è partita entro ${HANDOFF_MS / 1000} s: resto alla ${VERSION}`);
  }
  log(`${green('●')} aggiornato alla versione ${version}: passo la mano al nuovo companion (PID ${pid}) e mi chiudo`);
  // Chiusura pulita come con "stop": server MCP figli compresi. Il nuovo aspetta che questo processo esca.
  requestStop();
}

export type Swapped = { target: string; old: string }[];

/**
 * Mette la versione scaricata al posto delle copie in bin: quelle in uso diventano .old (rinominare
 * un .exe in esecuzione si può, sovrascriverlo no). Se qualcosa va storto rimette le vecchie e rilancia.
 */
export function swapBinaries(file: string): Swapped {
  const fresh = fs.readFileSync(file);
  const contents = [fresh, withoutConsole(fresh)];
  const swapped: Swapped = [];
  try {
    [consoleExe(), backgroundExe()].forEach((target, i) => {
      fs.writeFileSync(`${target}.new`, contents[i]);
      // Un .old di un aggiornamento precedente può essere ancora in uso: si usa un nome nuovo.
      let old = `${target}.old`;
      try { fs.rmSync(old, { force: true }); } catch { old = `${target}.${Date.now()}.old`; }
      if (fs.existsSync(target)) fs.renameSync(target, old);
      swapped.push({ target, old });
      fs.renameSync(`${target}.new`, target);
    });
  } catch (err) {
    restoreBinaries(swapped);
    throw err;
  }
  return swapped;
}

/** Rimette le copie vecchie al loro posto (aggiornamento non riuscito). */
export function restoreBinaries(swapped: Swapped) {
  for (const { target, old } of [...swapped].reverse()) {
    try { fs.rmSync(target, { force: true }); fs.renameSync(old, target); } catch { /* resta quello che c'è */ }
  }
  for (const c of [consoleExe(), backgroundExe()]) fs.rmSync(`${c}.new`, { force: true });
}

function configArg(): string | undefined {
  const i = process.argv.indexOf('--config');
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** All'avvio su Windows: toglie le copie .old e i file scaricati di un aggiornamento finito. */
export function cleanupAfterUpdate() {
  if (process.platform !== 'win32') return;
  const bin = path.dirname(backgroundExe());
  try {
    for (const f of fs.readdirSync(bin)) if (f.endsWith('.old')) { try { fs.rmSync(path.join(bin, f), { force: true }); } catch { /* ancora in uso */ } }
  } catch { /* bin non c'è: non installato */ }
  try {
    for (const f of fs.readdirSync(updatesDir())) if (!f.endsWith('.part')) fs.rmSync(path.join(updatesDir(), f), { force: true });
  } catch { /* nessun aggiornamento scaricato */ }
}
