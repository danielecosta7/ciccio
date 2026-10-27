import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { configDir, loadConfig, notifyDir, VERSION } from './config.js';
import { alive, claimInstance, clearHandoff, killTree, releaseInstance, requestStop, runningPid, stopRole, waitExit, waitHandoff, writeHandoff } from './instance.js';
import { backgroundExe, loginCommand, setLoginItem, startTray, startupDisabled, trayCommand } from './service.js';
import { cleanupAfterUpdate, restoreBinaries, swapBinaries } from './update.js';
import { closeWindows, dialog, iconFiles, permissionChecks, registerApp, showPermissions, startMenuShortcut, toastXml, TrayUi, type MenuItem, type PermissionsEnv, type TrayState } from './windows-ui.js';
import { log } from './log.js';

// Ciccio Companion per Windows: icona nell'area di notifica che tiene acceso il companion e ne
// mostra lo stato, come l'app della barra dei menu del Mac (companion/mac/main.swift), stesse voci.
// - Il companion è un processo figlio ("run --background"): se muore riparte, con attesa crescente fino a 30 s.
// - L'interfaccia non aspetta mai il companion: «Ricollega» gli chiede di chiudersi e lo riaccende
//   quando è uscito; se dopo 5 s è ancora vivo lo chiude a forza, con tutto l'albero dei processi.
// - Aggiornamento: il companion scarica e controlla la versione nuova (status.json › update), l'icona
//   sostituisce gli .exe in bin, avvia la nuova icona e si chiude.

const statusFile = () => path.join(configDir(), 'status.json');
const stateFile = () => path.join(configDir(), 'tray-state.json');
const actionFile = () => path.join(configDir(), 'tray.action');
const settingsFile = () => path.join(configDir(), 'tray-settings.json');
/** Notifiche più vecchie di così (PC spento, icona chiusa) non si mostrano più. */
const NOTIFY_MAX_AGE_MS = 10 * 60_000;

/** Cosa controllare nella finestra dei permessi, secondo la config di questo PC. */
export function permissionsEnv(configPath: string): PermissionsEnv {
  let cfg: ReturnType<typeof loadConfig> | null = null;
  try { cfg = loadConfig(configPath); } catch { /* non ancora collegato */ }
  const servers = Object.entries(cfg?.mcpServers ?? {}).filter(([, e]) => !e.disabled);
  return {
    notifyOption: cfg?.notifications !== false,
    needsNode: servers.some(([, e]) => 'command' in e && /^(npx|node|npm)(\.cmd|\.exe)?$/i.test(path.basename(e.command))),
    affinity: servers.some(([name]) => name === 'affinity'),
    statusFile: path.join(configDir(), 'status.json'),
    runCommand: trayCommand(configPath),
  };
}

/** Accende o spegne «Notifiche di Ciccio» nella config, lasciando tutto il resto com'è. */
export function setNotifications(configPath: string, on: boolean) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  raw.notifications = on;
  fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

interface Status {
  connected: boolean; device: string | null; problem: string;
  servers: { name: string; status: string; tools: number }[];
  update?: { version: string; path: string } | null;
}

/** «Ricollega» da PowerShell (ciccio-companion reconnect): l'icona lo legge entro un secondo. */
export function requestTrayAction(action: 'reconnect') {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(actionFile(), action);
}

export async function runTray(configPath: string, replaces?: number) {
  if (process.platform !== 'win32') throw new Error("L'icona nell'area di notifica è solo per Windows: sul Mac c'è Ciccio Companion.app.");
  if (replaces) {
    // Dopo un aggiornamento: si dice di essere partiti e si aspetta che la vecchia icona si chiuda.
    writeHandoff(VERSION, 'tray');
    log(`icona · versione ${VERSION} installata: aspetto che si chiuda la precedente (PID ${replaces})`);
    await waitExit(replaces);
    clearHandoff('tray');
  }
  const other = runningPid('tray');
  if (other) { log(`icona · già accesa (PID ${other})`); return; }
  new Tray(configPath).start();
}

class Tray {
  private child: ChildProcess | null = null;
  private stopping = false;
  /** Ricollega chiesto: quando il companion esce, riparte subito. */
  private restartPending = false;
  /** Avvio in corso (prima si chiude un eventuale companion rimasto acceso da solo). */
  private starting = false;
  private updating = false;
  private failedUpdate: string | null = null;
  private restartDelay = 1000;
  private ui: TrayUi;
  private uiFailures = 0;

  constructor(private configPath: string) {
    this.ui = new TrayUi((e) => {
      if (e.type === 'ready') { this.uiFailures = 0; log(`icona · nell'area di notifica (visibile: ${e.visible !== false ? 'sì' : 'no'})`); this.refresh(); }
      if (e.type === 'click') void this.click(e.id);
      // setting: 0 = notifiche accese per Ciccio Companion (1 spente per l'app, 2 per tutte, 3 criteri di gruppo).
      if (e.type === 'toast') log(e.ok ? `icona · notifica mostrata (${e.id}, impostazione ${e.setting})` : `icona · notifica non mostrata (${e.id}): ${e.error}`);
      if (e.type === 'exit' && !this.stopping) {
        // Senza interfaccia il companion resta acceso; l'icona si riprova qualche volta.
        this.uiFailures++;
        log(`icona · interfaccia chiusa (codice ${e.code})${e.error ? `: ${e.error.split('\n')[0]}` : ''}`);
        if (this.uiFailures <= 5) setTimeout(() => { if (!this.stopping) this.ui.start(); }, 5000 * this.uiFailures).unref();
      }
    });
  }

  start() {
    claimInstance(() => void this.quit('richiesto da ciccio-companion stop'), 'tray');
    process.on('exit', () => releaseInstance('tray'));
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.on(sig, () => void this.quit(sig));
    process.on('uncaughtException', (err) => log(`icona · errore imprevisto: ${err.stack ?? err.message}`));
    process.on('unhandledRejection', (err) => log(`icona · errore imprevisto: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
    cleanupAfterUpdate();
    log(`icona · Ciccio Companion ${VERSION}`);
    this.ui.start();
    this.startChild();
    setInterval(() => this.refresh(), 2000);
    setInterval(() => this.checkAction(), 1000).unref();
    setInterval(() => this.showNotifications(), 1000).unref();
    setInterval(() => void this.countMissing(), 5 * 60_000).unref();
    setTimeout(() => void this.countMissing(), 15_000).unref();
    void this.firstLaunch();
  }

  /** Registrazione per le notifiche (se manca, es. dopo un aggiornamento), poi la guida ai permessi la prima volta, poi l'abbinamento. */
  private async firstLaunch() {
    this.png = iconFiles(path.dirname(backgroundExe())).png;
    if (!fs.existsSync(startMenuShortcut()) && fs.existsSync(backgroundExe())) {
      const r = await registerApp(backgroundExe(), path.dirname(backgroundExe()));
      log(r.ok ? 'icona · registrata per le notifiche (menu Start)' : `icona · registrazione per le notifiche non riuscita: ${r.error}`);
    }
    let settings: { permissionsShown?: boolean } = {};
    try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { /* prima volta */ }
    if (!settings.permissionsShown) {
      fs.writeFileSync(settingsFile(), JSON.stringify({ ...settings, permissionsShown: true }));
      await this.permissions();
    }
    if (!this.paired()) await this.pairHelp();
  }

  private async permissions() {
    log('icona · finestra dei permessi');
    await showPermissions(permissionsEnv(this.configPath));
    void this.countMissing();
  }

  /** Quante voci della finestra dei permessi sono da sistemare (per il menu, come sul Mac). */
  private missing = 0;
  private async countMissing() {
    try {
      this.missing = (await permissionChecks(permissionsEnv(this.configPath))).filter((c) => c.ok === false).length;
      this.refresh();
    } catch { /* resta il conteggio di prima */ }
  }

  private png = '';

  /** Notifiche lasciate dal companion in notify/: si mostrano con l'icona di Ciccio e si cancellano. */
  private showNotifications() {
    if (this.stopping || !this.ui.running) return;
    let files: string[];
    try { files = fs.readdirSync(notifyDir()).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
    for (const f of files) {
      const file = path.join(notifyDir(), f);
      const at = Number(f.split('-')[0]);
      try {
        if (!(at > 0) || Date.now() - at > NOTIFY_MAX_AGE_MS) { fs.rmSync(file, { force: true }); continue; }
        const n = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string; title: string; body: string; url: string };
        fs.rmSync(file, { force: true });
        if (typeof n.url !== 'string' || !/^https?:\/\//.test(n.url)) continue;
        this.ui.toast(String(n.id), toastXml(n, this.png));
      } catch { try { fs.rmSync(file, { force: true }); } catch { /* resta */ } }
    }
  }

  // ── companion ─────────────────────────────────────────────────────────

  private config() { try { return loadConfig(this.configPath); } catch { return null; } }
  private paired() { return !!this.config()?.token?.startsWith('ccp_'); }
  /** '' finché il PC non è collegato: l'indirizzo di Ciccio arriva con il primo abbinamento. */
  private serverUrl() { return this.config()?.server ?? ''; }

  private startChild() {
    if (this.child || this.starting || this.stopping || !this.paired()) return;
    this.starting = true;
    // Un companion rimasto acceso da solo terrebbe il posto e il nuovo non partirebbe: prima gli si chiede di chiudersi.
    void stopRole('companion', 5000).then(() => { this.starting = false; this.launchChild(); });
  }

  private launchChild() {
    if (this.child || this.stopping || !this.paired()) return;
    const p = spawn(process.execPath, ['run', '--background', '--config', this.configPath], {
      env: { ...process.env, CICCIO_COMPANION_TRAY: '1' }, stdio: 'ignore', windowsHide: true,
    });
    this.child = p;
    p.on('error', (err) => log(`icona · il companion non parte: ${err.message}`));
    p.on('exit', (code) => {
      if (this.child !== p) return;
      this.child = null;
      if (this.restartPending) { this.restartPending = false; this.restartDelay = 1000; this.startChild(); this.refresh(); return; }
      if (this.stopping || this.updating) return;
      // Riparte da solo, con attesa crescente fino a 30 secondi.
      const wait = this.restartDelay;
      this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
      log(`icona · il companion si è chiuso (codice ${code}): riparte tra ${wait / 1000} s`);
      setTimeout(() => this.startChild(), wait);
      this.refresh();
    });
    setTimeout(() => { if (this.child === p) this.restartDelay = 1000; }, 60_000).unref();
  }

  /** Mai aspettare il companion: si chiede l'uscita e riparte quando il processo è finito. */
  private restartChild() {
    this.restartDelay = 1000;
    fs.rmSync(statusFile(), { force: true });
    const p = this.child;
    if (!p) { if (!this.starting) this.startChild(); this.refresh(); return; }
    this.restartPending = true;
    requestStop('companion');
    // Se dopo 5 secondi è ancora vivo, si chiude a forza (con i server MCP figli).
    setTimeout(() => { if (this.child === p && p.exitCode === null && p.pid) { log('icona · il companion non si chiude: lo chiudo a forza'); killTree(p.pid); } }, 5000);
    this.refresh();
  }

  private readStatus(): Status | null {
    if (!this.child) return null;
    try { return JSON.parse(fs.readFileSync(statusFile(), 'utf8')) as Status; } catch { return null; }
  }

  private checkAction() {
    let action = '';
    try { action = fs.readFileSync(actionFile(), 'utf8').trim(); fs.rmSync(actionFile(), { force: true }); } catch { return; }
    if (action === 'reconnect') this.restartChild();
  }

  // ── menu ──────────────────────────────────────────────────────────────

  private menu(st: Status | null): MenuItem[] {
    const m: MenuItem[] = [{ text: 'Ciccio Companion', disabled: true }];
    const paired = this.paired();
    if (!paired) {
      m.push({ text: 'Non ancora collegato', disabled: true }, { text: 'Collega a Ciccio…', id: 'pair' });
    } else if (st?.connected) {
      m.push({ text: `● Collegato come «${st.device ?? 'pc'}»`, disabled: true });
      for (const s of st.servers ?? []) m.push({ text: `    ${s.name}: ${s.status === 'online' ? `${s.tools} strumenti` : 'non disponibile'}`, disabled: true });
    } else {
      m.push({ text: `○ ${(st?.problem || 'In collegamento…').slice(0, 80)}`, disabled: true });
    }
    m.push({ sep: true }, { text: 'Apri Ciccio', id: 'open' });
    if (paired) m.push({ text: 'Ricollega', id: 'reconnect' });
    m.push(
      { text: "Avvia all'accesso", id: 'login', checked: loginCommand() != null && !startupDisabled() },
      { text: 'Notifiche di Ciccio', id: 'notifications', checked: paired && this.config()?.notifications !== false },
      { text: this.missing > 0 ? `Permessi… (${this.missing} da attivare)` : 'Permessi…', id: 'permissions' },
      { text: 'Strumenti esposti…', id: 'config' },
      { text: 'Registro', id: 'log' },
      { sep: true },
      { text: 'Esci', id: 'quit' },
    );
    return m;
  }

  private refresh() {
    if (this.stopping) return;
    const st = this.readStatus();
    if (st?.update && !this.updating && this.failedUpdate !== st.update.version) void this.installUpdate(st.update);
    const on = st?.connected === true;
    const state: TrayState = { on, tooltip: on ? 'Ciccio Companion · collegato' : 'Ciccio Companion · non collegato', menu: this.menu(st) };
    this.ui.send(state);
    // Lo stesso stato in un file: per "status" e per le prove automatiche.
    try {
      const tmp = `${stateFile()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...state, version: VERSION, childPid: this.child?.pid ?? null, ui: this.ui.running, updatedAt: Date.now() }));
      fs.renameSync(tmp, stateFile());
    } catch { /* solo informativo */ }
    if (!this.child && this.paired() && !this.restartPending && !this.starting && !this.updating) this.startChild();
  }

  private async click(id: string) {
    const open = (prog: string, arg: string) => spawn(prog, [arg], { detached: true, stdio: 'ignore' }).unref();
    switch (id) {
      case 'pair': return this.pairHelp();
      case 'open': return this.serverUrl() ? open('explorer.exe', this.serverUrl()) : this.pairHelp();
      case 'reconnect': return this.restartChild();
      case 'login': setLoginItem(loginCommand() == null || startupDisabled(), this.configPath); return this.refresh();
      case 'notifications':
        if (!this.paired()) { await dialog('Ancora niente da mostrare', 'Le notifiche arrivano quando colleghi il PC a Ciccio.'); return; }
        setNotifications(this.configPath, this.config()?.notifications === false);
        void this.countMissing();
        // Il companion lo dice a Ciccio quando si ricollega.
        return this.restartChild();
      case 'permissions': return this.permissions();
      case 'config':
        if (fs.existsSync(this.configPath)) return open('notepad.exe', this.configPath);
        await dialog('Ancora niente da mostrare', 'La configurazione nasce quando colleghi il PC a Ciccio.');
        return;
      case 'log': return open('notepad.exe', path.join(configDir(), 'companion.log'));
      case 'quit': return this.quit('Esci');
    }
  }

  private async pairHelp() {
    const server = this.serverUrl();
    // Prima volta: l'indirizzo non lo sappiamo ancora, Ciccio lo apri tu nel browser.
    if (!server) { await dialog('Collega Ciccio Companion', 'Apri il tuo Ciccio nel browser, vai in Impostazioni › Companion e premi «Collega questo PC».'); return; }
    const c = await dialog('Collega Ciccio Companion', 'Apri Ciccio › Impostazioni › Companion e premi «Collega questo PC».', ['Apri Ciccio', 'Più tardi']);
    if (c === 0) spawn('explorer.exe', [server], { detached: true, stdio: 'ignore' }).unref();
  }

  // ── aggiornamento ─────────────────────────────────────────────────────

  /** Versione nuova scaricata e controllata dal companion: si sostituiscono gli .exe e riparte l'icona nuova. */
  private async installUpdate(u: { version: string; path: string }) {
    if (!fs.existsSync(u.path)) return;
    this.updating = true;
    log(`icona · installo la versione ${u.version}`);
    let swapped;
    try { swapped = swapBinaries(u.path); } catch (err) {
      log(`icona · aggiornamento ${u.version} non riuscito: ${(err as Error).message}`);
      this.failedUpdate = u.version; this.updating = false; return;
    }
    clearHandoff('tray');
    startTray(this.configPath, ['--replaces', String(process.pid)]);
    const pid = await waitHandoff(u.version, 20_000, 'tray');
    if (!pid) {
      restoreBinaries(swapped);
      log(`icona · la versione ${u.version} non è partita entro 20 s: resto alla ${VERSION}`);
      this.failedUpdate = u.version; this.updating = false; return;
    }
    log(`icona · aggiornata alla versione ${u.version}: passo la mano alla nuova icona (PID ${pid})`);
    await this.quit(`aggiornamento alla ${u.version}`);
  }

  // ── uscita ────────────────────────────────────────────────────────────

  /** Esci: chiude l'interfaccia e il companion (con i server MCP figli), al massimo in 3 secondi più la chiusura forzata. */
  private async quit(why: string) {
    if (this.stopping) return;
    this.stopping = true;
    log(`icona · chiudo (${why})`);
    this.ui.stop();
    closeWindows();
    const p = this.child;
    if (p?.pid && p.exitCode === null) {
      requestStop('companion');
      for (let t = 0; t < 5000 && p.exitCode === null && alive(p.pid); t += 100) await new Promise((r) => setTimeout(r, 100));
      if (p.exitCode === null) killTree(p.pid);
    }
    fs.rmSync(stateFile(), { force: true });
    releaseInstance('tray');
    setTimeout(() => process.exit(0), 300);
  }
}

/** Versioni fino alla 0.3.0: la chiave Run avviava il companion senza icona. Va sostituita con l'icona? */
export function needsTrayMigration(): boolean {
  if (process.platform !== 'win32' || process.env.CICCIO_COMPANION_TRAY === '1') return false;
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(backgroundExe()).toLowerCase()) return false;
  const cmd = loginCommand();
  return cmd != null && / run --background/.test(cmd) && runningPid('tray') == null;
}
