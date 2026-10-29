#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { cli, defaultConfigPath, loadConfig, migrateConfig, templateConfig, writeConfig, VERSION, underTray } from './config.js';
import { LocalServers } from './servers.js';
import { ciccioTransfer } from './transfer.js';
import { CiccioLink } from './link.js';
import { OnePasswordGuard } from './consensi.js';
import { PcBridges } from './ponte.js';
import { install, installed, startTray, uninstall } from './service.js';
import { needsTrayMigration, requestTrayAction, runTray } from './tray.js';
import { dialog } from './windows-ui.js';
import { checkToken, normServer, pairQuestion, parsePairLink } from './pair.js';
import { claimInstance, clearHandoff, logFile, releaseInstance, runningPid, stopRunning, waitExit, writeHandoff } from './instance.js';
import { cleanupAfterUpdate } from './update.js';
import { dim, green, log, logToFile, red, yellow } from './log.js';
import { clearStatus } from './status.js';

// Companion di Ciccio: rende disponibili agli agenti sul server i server MCP di questo PC.
// Solo connessione in uscita verso Ciccio; sul PC non si apre nessuna porta.

const HELP = `Ciccio Companion ${VERSION}

Uso (da terminale «ciccio-companion» è ${cli()}):
  ciccio-companion init <token> --server URL     crea la config (${defaultConfigPath()}); poi --server si può omettere
  ciccio-companion pair <link>                   collega con il link di Ciccio («Collega questo PC»)
  ciccio-companion [run]                         si collega a Ciccio e resta acceso in questa finestra
  ciccio-companion check                         prova i server MCP locali ed elenca gli strumenti
  ciccio-companion install | uninstall           avvio automatico all'accesso, senza finestra (Mac, Windows)
  ciccio-companion status                        è acceso? ultime righe del registro
  ciccio-companion stop                          chiude il companion in background
  ciccio-companion setup                         Windows: si installa (anche con un doppio clic sull'.exe)
  ciccio-companion tray                          Windows: icona nell'area di notifica che tiene acceso il companion
  ciccio-companion reconnect                     Windows: «Ricollega» dell'icona
  ciccio-companion notifications on|off          come «Notifiche di Ciccio» nel menu dell'icona
  ciccio-companion permissions [--json]          Windows: finestra «Permessi di Ciccio Companion» (o i controlli in JSON)

Opzioni:
  --config <file>   config da usare al posto di quella predefinita
  --background      niente terminale: scrive nel registro (${logFile()})
  --replaces <pid>  (interno) prende il posto del companion <pid> dopo un aggiornamento
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/**
 * Su Windows la finestra aperta con un doppio clic (o dal link di abbinamento) si chiuderebbe
 * prima di poter leggere: si aspetta Invio.
 */
const ownWindow = () => process.platform === 'win32' && !!process.stdin.isTTY && (process.argv.length <= 2 || process.argv[2] === 'pair' || process.argv[2] === 'setup');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ask(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [s/N] `);
  rl.close();
  return /^(s|si|sì|y|yes)$/i.test(answer.trim());
}

function saveToken(configPath: string, token: string, server: string) {
  if (fs.existsSync(configPath)) {
    // Config esistente: si cambia solo il token (e il server), i server MCP restano.
    const cfg = loadConfig(configPath);
    writeConfig(configPath, { ...cfg, token, server });
    console.log(`Token aggiornato in ${configPath}`);
  } else {
    writeConfig(configPath, templateConfig(token, server));
    console.log(`Config creata: ${configPath}\nDentro ci sono Affinity, Chrome (profilo dedicato), «file» e «comandi»: le cartelle e i comandi li chiedono gli agenti e li consenti tu sul PC.`);
  }
}

const hasToken = (configPath: string) => { try { return !!loadConfig(configPath).token; } catch { return false; } };
/** Server della config di questo PC ('' se non c'è ancora). Una config rotta ferma l'abbinamento. */
const currentServer = (configPath: string) => fs.existsSync(configPath) ? loadConfig(configPath).server : '';

/**
 * Windows, doppio clic sull'.exe scaricato: si copia nella sua cartella, registra il link e l'avvio
 * all'accesso e accende l'icona nell'area di notifica (che, se non è ancora collegato, spiega come farlo).
 */
async function setup(configPath: string) {
  if (process.platform !== 'win32') throw new Error('setup serve solo su Windows: sul Mac c\'è Ciccio Companion.app.');
  console.log(`Ciccio Companion ${VERSION}\n`);
  console.log(await install(configPath));
  console.log(hasToken(configPath)
    ? '\nÈ collegato a Ciccio: lo stato è nell\'icona di Ciccio in basso a destra.'
    : '\nOra collegalo: apri Ciccio › Impostazioni › Companion e premi «Collega questo PC».');
}

/** Il link aperto dal browser avvia la copia senza console: domande e risposte in finestre vere, come sul Mac. */
async function pairWindow(configPath: string, link: string) {
  // Senza console: ogni passo nel registro, così un abbinamento che non arriva si vede (menu › Registro).
  logToFile(logFile());
  log('abbinamento · link ricevuto dal browser');
  let p;
  try { p = parsePairLink(link, currentServer(configPath)); } catch (err) {
    const msg = (err as Error).message;
    log(red(`abbinamento · ${msg}`));
    await dialog(msg.startsWith('Server') ? 'Server non riconosciuto' : 'Link non valido', msg);
    return;
  }
  const host = new URL(p.server).host;
  const q = pairQuestion(p);
  const c = await dialog(q.title, q.body, ['Collega', 'Annulla']);
  if (c !== 0) { log('abbinamento · annullato nella finestra'); return; }
  const check = await checkToken(p);
  log(`abbinamento · token ${check === 'ok' ? 'valido' : check === 'rejected' ? 'rifiutato da Ciccio' : `non controllato (${host} non risponde)`}`);
  if (check === 'rejected') { await dialog('Abbinamento non riuscito', 'Ciccio non riconosce questo token (scaduto o dispositivo rimosso): premi di nuovo «Collega questo PC».'); return; }
  saveToken(configPath, p.token, p.server);
  log('abbinamento · token salvato, il companion si collega');
  // L'icona accesa riparte con il token nuovo; se non c'è, si accende.
  if (runningPid('tray')) requestTrayAction('reconnect');
  else startTray(configPath);
  await dialog('PC collegato a Ciccio', check === 'unreachable'
    ? `Ciccio (${host}) non risponde adesso: il companion riprova da solo. Lo stato è nell'icona di Ciccio in basso a destra.`
    : "Trovi lo stato nell'icona di Ciccio in basso a destra, nell'area di notifica.");
}

/** Link ciccio-companion://pair da Ciccio: conferma, controllo del token, config e avvio in background. */
async function pair(configPath: string, link: string, yes: boolean) {
  const p = parsePairLink(link, currentServer(configPath));
  const host = new URL(p.server).host;
  const q = pairQuestion(p);
  console.log(`Ciccio Companion ${VERSION}\n`);
  if (!yes && !(await ask(`${q.title}\n${q.body}`))) {
    console.log('Annullato: niente è cambiato.');
    return;
  }
  const check = await checkToken(p);
  if (check === 'rejected') throw new Error('Ciccio non riconosce questo token (scaduto o dispositivo rimosso): premi di nuovo «Collega questo PC».');
  if (check === 'unreachable') console.log(yellow(`Ciccio (${host}) non risponde adesso: salvo il collegamento, il companion riprova da solo.`));
  saveToken(configPath, p.token, p.server);
  await useNewToken(configPath);
  console.log(green(`\nCollegato. In Ciccio questo PC compare in Impostazioni › Companion.`));
}

/** Token appena salvato (pair o init): il companion acceso riparte con quello, senza altri comandi. */
async function useNewToken(configPath: string) {
  if (process.platform === 'win32') {
    if (runningPid('tray')) { requestTrayAction('reconnect'); console.log('Ricollego il companion acceso (icona di Ciccio in basso a destra).'); }
    else console.log(await install(configPath));
    return;
  }
  if (runningPid()) {
    // L'app del Mac lo riaccende da sola quando si chiude (il LaunchAgent di install no, dopo un'uscita normale).
    await stopRunning();
    for (let t = 0; t < 8000 && !runningPid(); t += 500) await sleep(500);
    console.log(runningPid() ? 'Il companion è ripartito con il token nuovo.' : `Companion chiuso: riaccendilo con ${cli()} install (o apri l'app Ciccio Companion).`);
  } else {
    console.log(`Apri l'app Ciccio Companion (o lancia ${cli()} install): si collega con il token nuovo.`);
  }
}

async function pause() {
  console.log('\nPremi Invio per chiudere.');
  await new Promise((r) => process.stdin.once('data', r));
}

function status(configPath: string) {
  const pid = runningPid();
  console.log(`Ciccio Companion ${VERSION}`);
  console.log(`Config: ${configPath}${fs.existsSync(configPath) ? '' : ` (non c’è ancora: ${cli()} init <token>)`}`);
  // Lo stato del collegamento lo scrive il companion acceso in ~/.ciccio-companion/status.json.
  let link = '';
  try {
    const st = JSON.parse(fs.readFileSync(path.join(path.dirname(logFile()), 'status.json'), 'utf8')) as { connected?: boolean; device?: string; problem?: string; servers?: { name: string; status: string; tools: number }[] };
    if (pid) {
      link = st.connected ? ` · collegato a Ciccio come «${st.device}»` : ` · non collegato${st.problem ? `: ${st.problem}` : ''}`;
      for (const sv of st.servers ?? []) link += `\n  ${sv.name}: ${sv.status === 'online' ? `${sv.tools} strumenti` : 'non disponibile'}`;
    }
  } catch { /* nessuno stato scritto */ }
  console.log(`Stato: ${pid ? `acceso (PID ${pid})${link}` : 'spento'}`);
  if (process.platform === 'win32') {
    const tray = runningPid('tray');
    console.log(`Icona nell'area di notifica: ${tray ? `accesa (PID ${tray})` : 'spenta'}`);
  }
  console.log(`Avvio automatico: ${installed() ? 'attivo' : 'no'}`);
  try {
    const lines = fs.readFileSync(logFile(), 'utf8').trimEnd().split('\n').slice(-15);
    console.log(`\nUltime righe di ${logFile()}:\n${lines.join('\n')}`);
  } catch { console.log('\nRegistro vuoto: il companion non è ancora partito in background.'); }
}

async function main() {
  // Senza comando: su Windows (doppio clic sull'.exe) si installa, altrove si collega e resta acceso.
  const cmd = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : process.platform === 'win32' && process.argv.length <= 2 ? 'setup' : 'run';
  const configPath = path.resolve(arg('--config') ?? defaultConfigPath());
  // L'icona non ha mai un terminale: scrive sempre nel registro, come il companion in background.
  const background = process.argv.includes('--background') || cmd === 'tray';
  if (background) logToFile(logFile());

  if (cmd === 'help' || process.argv.includes('--help') || process.argv.includes('-h')) { console.log(HELP); return; }
  if (cmd === 'version' || process.argv.includes('--version')) { console.log(VERSION); return; }

  if (cmd === 'init') {
    const token = process.argv[3];
    if (!token || !token.startsWith('ccp_')) throw new Error('Serve il token del dispositivo (inizia con ccp_): lo generi in Ciccio › Impostazioni › Companion.');
    // Il server scritto qui è l'unico per cui varranno i link di abbinamento.
    const given = arg('--server');
    const server = given ? normServer(given) : normServer(currentServer(configPath));
    if (given && !server) throw new Error(`Indirizzo non valido: ${given} (serve https://…).`);
    if (!server) throw new Error(`Serve l'indirizzo di Ciccio: ${cli()} init <token> --server https://…`);
    saveToken(configPath, token, server);
    await useNewToken(configPath);
    return;
  }

  // Dopo l'installazione la finestra si chiude da sola: da qui in poi parla l'icona.
  if (cmd === 'setup') { await setup(configPath); if (ownWindow()) await sleep(6000); return; }
  if (cmd === 'pair') {
    if (!process.argv[3]) throw new Error(`Manca il link: ${cli()} pair "ciccio-companion://pair?…"`);
    const yes = process.argv.includes('--yes');
    // Dal browser su Windows non c'è un terminale: finestre al posto delle domande nel prompt.
    if (process.platform === 'win32' && !yes && !process.stdin.isTTY) { await pairWindow(configPath, process.argv[3]); return; }
    await pair(configPath, process.argv[3], yes);
    if (ownWindow()) await pause();
    return;
  }

  // Sul Mac il LaunchAgent avvia subito il companion, che vuole il token; su Windows parte l'icona, che sa aspettarlo.
  if (cmd === 'install') { if (process.platform !== 'win32') loadConfig(configPath); console.log(await install(configPath)); return; }
  if (cmd === 'tray') { await runTray(configPath, Number(arg('--replaces')) || undefined); return; }
  if (cmd === 'notifications') {
    const on = process.argv[3];
    if (on !== 'on' && on !== 'off') throw new Error('Uso: ciccio-companion notifications on|off');
    const { setNotifications } = await import('./tray.js');
    setNotifications(configPath, on === 'on');
    // Il companion lo dice a Ciccio quando si ricollega (con l'icona accesa, subito).
    if (runningPid('tray')) requestTrayAction('reconnect');
    console.log(on === 'on' ? 'Notifiche di Ciccio accese.' : 'Notifiche di Ciccio spente.');
    return;
  }
  if (cmd === 'permissions') {
    if (process.platform !== 'win32') throw new Error('La finestra dei permessi è per Windows: sul Mac è nell\'app Ciccio Companion.');
    const { permissionsEnv } = await import('./tray.js');
    const { permissionChecks, showPermissions } = await import('./windows-ui.js');
    if (process.argv.includes('--json')) console.log(JSON.stringify(await permissionChecks(permissionsEnv(configPath)), null, 2));
    else await showPermissions(permissionsEnv(configPath));
    return;
  }
  if (cmd === 'reconnect') {
    if (!runningPid('tray')) throw new Error(`L'icona di Ciccio Companion non è accesa: ${cli()} install`);
    requestTrayAction('reconnect');
    console.log('Ricollego.');
    return;
  }
  if (cmd === 'uninstall') { console.log(await uninstall()); return; }
  if (cmd === 'status') { status(configPath); return; }
  if (cmd === 'stop') { console.log((await stopRunning()) ? 'Companion chiuso.' : 'Il companion non era acceso.'); return; }

  // Config create con versioni precedenti: i server integrati arrivati dopo (una volta sola).
  if (cmd === 'run' || cmd === 'check') {
    const added = migrateConfig(configPath);
    if (added.length) log(`versione ${VERSION}: aggiunto alla config il server integrato ${added.join(', ')}`);
  }
  const cfg = loadConfig(configPath);

  if (cmd === 'check') {
    const local = new LocalServers(configPath, cfg, { interactive: false });
    await local.startAll();
    for (const s of local.map.values()) {
      console.log(`\n${s.name} · ${s.state.status}${s.state.error ? ` · ${s.state.error}` : ''}`);
      for (const t of s.state.tools) console.log(`  ${t.name}${t.annotations?.readOnlyHint ? dim(' (sola lettura)') : ''}${t.description ? dim(` — ${t.description.split('\n')[0].slice(0, 90)}`) : ''}`);
    }
    await local.stopAll();
    process.exit(0);
  }

  if (cmd !== 'run') { console.log(HELP); process.exitCode = 1; return; }
  if (!cfg.token) throw new Error(`Manca il token in ${configPath}: ${cli()} init <token>`);
  if (!cfg.server) throw new Error(`Manca l'indirizzo di Ciccio in ${configPath}: ${cli()} init <token> --server https://…`);

  // Dopo un aggiornamento (Windows): il nuovo dice di essere partito e aspetta che il vecchio si chiuda.
  const replaces = Number(arg('--replaces'));
  if (replaces > 0) {
    writeHandoff(VERSION);
    log(`versione ${VERSION} installata: aspetto che si chiuda la precedente (PID ${replaces})`);
    await waitExit(replaces);
    clearHandoff();
  }
  cleanupAfterUpdate();

  // Windows, installazioni fino alla 0.3.0 (avvio automatico senza icona): da qui in poi parte l'icona,
  // che tiene acceso il companion. Succede da sola dopo l'aggiornamento automatico.
  if (background && needsTrayMigration()) {
    const { setLoginItem } = await import('./service.js');
    setLoginItem(true, configPath);
    startTray(configPath);
    log(`versione ${VERSION}: l'avvio automatico ora accende l'icona nell'area di notifica, che tiene acceso il companion`);
    return;
  }

  // Un solo companion per utente: due con lo stesso token si scalzerebbero a vicenda su Ciccio.
  const other = runningPid();
  if (other) {
    if (background) { log(`un altro companion è già acceso (PID ${other}): esco`); return; }
    throw new Error(`Il companion è già acceso in background (PID ${other}). Per usarlo in questa finestra: ${cli()} stop`);
  }

  if (background) {
    // Senza finestra un errore imprevisto non deve spegnere tutto in silenzio: si scrive e si va avanti.
    process.on('uncaughtException', (err) => log(red(`errore imprevisto: ${err.stack ?? err.message}`)));
    process.on('unhandledRejection', (err) => log(red(`errore imprevisto: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)));
  }

  // Server «file» e «comandi»: finestre su questo PC, scrittura nella config e file da e verso Ciccio.
  const local = new LocalServers(configPath, cfg, { transfer: ciccioTransfer(cfg.server, cfg.token) });
  const servers = local.map;
  log(`Ciccio Companion ${VERSION} · ${servers.size} server MCP: ${[...servers.keys()].join(', ') || 'nessuno'}${background ? ' · in background' : ''}`);
  // Le notifiche le mostra solo l'app dell'icona (Mac o Windows), se l'opzione è attiva.
  // 1Password: segreti e firme SSH solo con il consenso di chi è al PC (finestra o elenco nella config).
  // Ponti SSH: solo verso le destinazioni di ssh.ponti, che si aggiungono con la finestra del PC.
  const link = new CiccioLink(cfg.server, cfg.token, servers, cfg.notifications && underTray(), new OnePasswordGuard(configPath), new PcBridges(configPath));
  // Config cambiata (a mano o da una proposta accettata sul PC): server nuovi, tolti o cambiati, senza Ricollega.
  local.onAdded = (s) => link.attach(s);
  local.onChanged = () => link.serversChanged();
  local.onReloaded = () => link.bridgesChanged();
  void local.startAll();
  local.watch();
  link.connect();

  let quitting = false;
  const quit = async (why: string) => {
    if (quitting) return;
    quitting = true;
    log(`chiudo (${why})`);
    // Se un server MCP figlio non si chiude, si esce comunque dopo 5 secondi.
    setTimeout(() => process.exit(0), 5000).unref();
    link.stop();
    clearStatus();
    // Chiude anche i server MCP figli (npx, Chrome…), così non restano processi orfani.
    await local.stopAll();
    releaseInstance();
    process.exit(0);
  };
  claimInstance(() => void quit('richiesto da ciccio-companion stop'));
  // Non releaseInstance diretto: 'exit' passa il codice di uscita come primo argomento.
  process.on('exit', () => releaseInstance());
  process.on('SIGINT', () => void quit('Ctrl+C'));
  process.on('SIGTERM', () => void quit('SIGTERM'));
  // Windows: Ctrl+Interr e chiusura della finestra (SIGHUP arriva qualche secondo prima della chiusura).
  process.on('SIGBREAK', () => void quit('Ctrl+Interr'));
  process.on('SIGHUP', () => void quit('finestra chiusa'));
  // Sotto l'app dell'icona: se l'app sparisce di colpo (chiusa a forza, senza passare dalla sua uscita) il
  // companion resterebbe acceso da solo, senza nessuno che mostri le notifiche. Lo si scrive e si esce:
  // l'app, quando riparte, ne avvia uno nuovo.
  const tray = process.env.CICCIO_COMPANION_TRAY === '1' ? process.ppid : 0;
  if (tray > 1) {
    setInterval(() => {
      try { process.kill(tray, 0); } catch { void quit(`l'app dell'icona (pid ${tray}) non c'è più`); }
    }, 5000).unref();
  }
}

main().catch(async (err: Error) => {
  // Anche l'abbinamento aperto dal browser non ha una console: l'errore va nel registro.
  if (process.argv.includes('--background') || (process.argv[2] === 'pair' && !process.stdin.isTTY)) log(red(err.message));
  else console.error(red(err.message));
  if (ownWindow()) await pause();
  process.exit(1);
});
