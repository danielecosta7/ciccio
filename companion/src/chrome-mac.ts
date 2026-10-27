import { spawn } from 'node:child_process';
import { log, dim } from './log.js';

// Chrome sul Mac, aperto come app a sé e non come figlio del companion.
//
// Se chrome-devtools-mcp lancia Chrome lui, Chrome è un processo figlio di Ciccio Companion e macOS
// mette sul conto dell'app quello che Chrome fa all'avvio (si aggiorna, legge i suoi dati): chiede
// «Gestione app» e «Dati di altre app» per Ciccio Companion, e di nuovo dopo ogni aggiornamento,
// perché l'app non ha una firma fissa. Concedere il permesso fa anche chiudere l'app.
//
// Così invece: Chrome si apre con `open` (Launch Services, come da Finder) sul profilo dedicato, con
// la porta di debug solo su 127.0.0.1, e chrome-devtools-mcp ci si collega (--browserUrl). Chrome
// risponde per sé dei suoi permessi e resta aperto anche se il companion si riavvia o si aggiorna.

export const CHROME_PORT = 9333;

export interface DetachedChrome { profile: string; port: number }

/**
 * chrome-devtools-mcp configurato per lanciare Chrome da sé (--userDataDir): sul Mac diventa
 * --browserUrl verso un Chrome staccato con lo stesso profilo. Altrimenti null (config già a posto,
 * altro server, altro sistema).
 */
export function detachChrome(args: string[], profileDefault: string): { args: string[]; chrome: DetachedChrome } | null {
  if (process.platform !== 'darwin' || !args.some((a) => a.includes('chrome-devtools-mcp'))) return null;
  if (args.some((a) => /^(--browserUrl|--browser-url|--wsEndpoint|--ws-endpoint|-u|-w|--autoConnect|--auto-connect)(=|$)/.test(a))) return null;
  let profile = profileDefault;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--userDataDir' || a === '--user-data-dir') { profile = args[++i] ?? profile; continue; }
    const m = /^--(?:userDataDir|user-data-dir)=(.+)$/.exec(a);
    if (m) { profile = m[1]; continue; }
    // Opzioni che valgono solo quando è chrome-devtools-mcp ad aprire Chrome.
    if (a === '--isolated' || a.startsWith('--channel') || a.startsWith('--executablePath') || a.startsWith('--chromeArg')) continue;
    out.push(a);
  }
  out.push('--browserUrl', `http://127.0.0.1:${CHROME_PORT}`);
  return { args: out, chrome: { profile, port: CHROME_PORT } };
}

async function alive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

/** Chrome è aperto sulla porta? Se no lo apre e aspetta che risponda. true = l'ha appena aperto. */
export async function ensureChrome(c: DetachedChrome): Promise<boolean> {
  if (await alive(c.port)) return false;
  log(dim(`apro Chrome (profilo ${c.profile})`));
  spawn('/usr/bin/open', [
    '-n', '-g', '-a', 'Google Chrome', '--args',
    `--user-data-dir=${c.profile}`,
    `--remote-debugging-port=${c.port}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check',
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await alive(c.port)) return true;
  }
  throw new Error('Chrome non si è aperto entro 20 secondi');
}
