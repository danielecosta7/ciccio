import { execFile } from 'node:child_process';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { cleanDomain, domainAllowed, egressHelper } from './egress.js';
import { OWNER } from './config.js';

// installa_programma: l'agente chiede un programma di sistema (pacchetto ufficiale di Ubuntu) che manca sul server.
// Prima Ciccio controlla, senza root, che il pacchetto esista e cosa porterebbe con sé; poi chiede SEMPRE
// all'utente (in ogni livello, «Salta permessi» compreso, mai «sempre»); solo dopo il suo sì lancia con sudo
// l'helper root /usr/local/sbin/ciccio-apt-install (deploy/apt-helper.sh), che rifà tutti i controlli da sé.

export const SYSTEM_SERVER = 'ciccio_sistema';
export const INSTALL_TOOL = `mcp__${SYSTEM_SERVER}__installa_programma`;
export const EGRESS_TOOL = `mcp__${SYSTEM_SERVER}__consenti_dominio`;
const HELPER = '/usr/local/sbin/ciccio-apt-install';

/** Nome di pacchetto Debian semplice: niente versioni (=), architetture (:), file, URL, PPA o opzioni. */
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9.+-]{1,62}$/;
/** Riga «Inst» di apt-get -s con tutte le origini Ubuntu: Inst nome [vecchia] (versione Ubuntu:24.04/noble[, …] [arch]). */
const UBUNTU_INST = /\([^ ]+ Ubuntu:[0-9.]+\/[a-z-]+(, Ubuntu:[0-9.]+\/[a-z-]+)* \[[a-z0-9]+\]\)$/;

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });

function exec(cmd: string, args: string[], timeout: number, signal: AbortSignal): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, signal, maxBuffer: 4 << 20, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}${err && !stdout && !stderr ? err.message : ''}` });
    });
  });
}

/** Versione per la chat: senza epoca e senza revisione Debian (1:2021.01-6build4 → 2021.01). */
export function shortVersion(v: string): string {
  return v.replace(/^\d+:/, '').replace(/-[^-]*$/, '') || v;
}

export interface InstallPlan { error?: string; deps: string[]; upgrades: string[] }

/** Legge la simulazione di apt-get: cosa entrerebbe e se va bene (solo Ubuntu, niente rimozioni, nome esatto). */
export function readPlan(out: string, pkg: string): InstallPlan {
  const lines = out.split('\n');
  const inst = lines.filter((l) => l.startsWith('Inst '));
  const name = (l: string) => l.split(' ')[1];
  const plan: InstallPlan = { deps: inst.map(name).filter((n) => n !== pkg), upgrades: inst.filter((l) => / \[[^\]]+\] \(/.test(l)).map(name) };
  const e = lines.find((l) => l.startsWith('E: '));
  if (e) return { ...plan, error: /Unable to locate|no installation candidate/.test(e) ? `${pkg} non c'è nei repository di Ubuntu configurati sul server.` : e.slice(3, 200) };
  const note = lines.find((l) => l.startsWith('Note, selecting'));
  if (note) return { ...plan, error: `${pkg} non è il nome esatto di un pacchetto (${note.slice(0, 160)}).` };
  const removed = lines.filter((l) => l.startsWith('Remv ')).map(name);
  if (removed.length) return { ...plan, error: `L'installazione toglierebbe pacchetti (${removed.join(', ')}): non si fa.` };
  if (!inst.some((l) => name(l) === pkg)) return { ...plan, error: `${pkg} non risulta da installare.` };
  const other = inst.filter((l) => !UBUNTU_INST.test(l)).map(name);
  if (other.length) return { ...plan, error: `Non vengono dai repository ufficiali di Ubuntu: ${other.join(', ')}. Questi non si installano da Ciccio.` };
  return plan;
}

export interface SystemHooks {
  /** Chiede all'utente con la card dei permessi di quello strumento; true = approvato. */
  ask: (tool: string, input: Record<string, unknown>, reason: string) => Promise<boolean>;
  /** Riga discreta nella chat (come le altre note degli strumenti). */
  note: (t: string) => void;
  /** Progetto e chat, solo per il registro dell'helper. */
  who: string;
}

/** Server MCP della sessione: un'istanza per giro. */
export function systemServer(hooks: SystemHooks, signal: AbortSignal): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SYSTEM_SERVER,
    version: '1.0.0',
    tools: [
      tool('installa_programma',
        'Chiede di installare sul server un programma di sistema che manca (pacchetto ufficiale di Ubuntu, es. openscad, imagemagick, ffmpeg). ' +
        `${OWNER} approva ogni installazione in Ciccio; tu non puoi usare sudo o apt. Si installano solo pacchetti dei repository ufficiali di Ubuntu, con le loro dipendenze, senza togliere né aggiornare altro. ` +
        'Dopo, i comandi che usano il programma seguono il livello di autorizzazione della chat come gli altri.',
        {
          pacchetto: z.string().max(80).describe('nome esatto del pacchetto Ubuntu, es. openscad (niente versioni, file .deb, URL o PPA)'),
          motivo: z.string().min(3).max(300).describe(`a cosa ti serve, in una riga: lo legge ${OWNER} quando approva`),
        },
        async ({ pacchetto, motivo }) => {
          const pkg = pacchetto.trim();
          if (!PACKAGE_NAME.test(pkg)) return text(`Nome non valido: «${pacchetto.slice(0, 80)}». Serve solo il nome del pacchetto Ubuntu (minuscole, cifre, . + -), senza versioni, file .deb, URL, PPA o opzioni.`, true);
          if (process.platform !== 'linux') return text('Installare programmi si può solo sul server Linux di Ciccio.', true);
          const have = await exec('dpkg-query', ['-W', '-f=${db:Status-Status} ${Version}', pkg], 10_000, signal);
          const [state, version] = have.out.trim().split(' ');
          if (have.code === 0 && state === 'installed') return text(`${pkg} è già installato (${version}): usalo pure.`);
          // Simulazione senza root: se il pacchetto non va bene, l'utente non viene nemmeno disturbato.
          const sim = await exec('apt-get', ['-s', '-q', 'install', '--no-install-recommends', pkg], 60_000, signal);
          const plan = readPlan(sim.out, pkg);
          if (plan.error) return text(plan.error, true);
          const extra = [
            plan.deps.length ? `+ ${plan.deps.length} dipendenz${plan.deps.length === 1 ? 'a' : 'e'}` : 'nessuna dipendenza',
            plan.upgrades.length ? `aggiorna ${plan.upgrades.join(', ')}` : '',
          ].filter(Boolean).join(', ');
          const ok = await hooks.ask(INSTALL_TOOL, { pacchetto: pkg, motivo, dipendenze: plan.deps.slice(0, 40) }, `pacchetto ufficiale Ubuntu, ${extra}; lo approvi solo tu`);
          if (!ok) return text(`${OWNER} non ha approvato l'installazione di ${pkg}.`, true);
          const r = await exec('sudo', ['-n', HELPER, pkg, hooks.who], 16 * 60_000, signal);
          const last = r.out.trim().split('\n').pop() ?? '';
          const m = /^(OK|GIA) (\S+) (\S+)$/.exec(last);
          if (r.code === 0 && m) {
            hooks.note(`${m[1] === 'OK' ? 'installato' : 'già installato'} ${pkg} ${shortVersion(m[3])}`);
            return text(`${m[1] === 'OK' ? 'Installato' : 'Era già installato'} ${pkg} ${m[3]}${m[1] === 'OK' && plan.deps.length ? ` con ${plan.deps.length} dipendenze` : ''}. I comandi che lo usano seguono il livello di autorizzazione della chat.`);
          }
          const reason = last.startsWith('ERRORE ') ? last.slice(7)
            : /password is required|not allowed|may not run sudo|no new privileges|command not found|No such file/i.test(r.out) ? "l'installazione dal server non è attiva (manca l'helper ciccio-apt-install): va attivata con deploy/apt-helper.sh"
            : last.slice(0, 200) || `uscita ${r.code}`;
          hooks.note(`✗ installazione di ${pkg} non riuscita: ${reason}`);
          return text(`Installazione di ${pkg} non riuscita: ${reason}\n${r.out.trim().split('\n').slice(-15, -1).join('\n')}`.trim(), true);
        }),
      tool('consenti_dominio',
        'Chiede di aprire un dominio nel proxy in uscita del server: gli agenti raggiungono internet solo dai domini consentiti, ' +
        'e un sito fuori elenco risponde con un errore del proxy (403 o 502, «Proxying refused», «CONNECT tunnel failed»). ' +
        `${OWNER} approva ogni dominio in Ciccio; dopo resta aperto per tutti gli agenti finché non lo toglie. Chiedi solo il dominio che serve davvero ` +
        "(es. export-download.canva.com, non canva.com con tutti i sottodomini), senza IP, porte o percorsi.",
        {
          dominio: z.string().max(260).describe('nome del dominio, es. export-download.canva.com (va bene anche un indirizzo: si tiene solo il dominio)'),
          sottodomini: z.boolean().optional().describe('true per aprire anche tutti i sottodomini (es. un CDN con nomi che cambiano); di norma no'),
          motivo: z.string().min(3).max(300).describe(`a cosa ti serve, in una riga: lo legge ${OWNER} quando approva`),
        },
        async ({ dominio, sottodomini, motivo }) => {
          const subs = !!sottodomini;
          const c = cleanDomain(dominio, subs);
          if ('error' in c) return text(c.error, true);
          if (process.platform !== 'linux') return text('I domini del proxy si cambiano solo sul server Linux di Ciccio.', true);
          if (domainAllowed(c.domain)) return text(`${c.domain} è già consentito dal proxy: se non risponde, il problema è un altro (indirizzo, certificato o servizio giù).`);
          const ok = await hooks.ask(EGRESS_TOOL, { dominio: c.domain, sottodomini: subs, motivo }, subs ? 'dominio con tutti i sottodomini, per tutti gli agenti; lo approvi solo tu' : 'dominio nuovo per tutti gli agenti; lo approvi solo tu');
          if (!ok) return text(`${OWNER} non ha aperto ${c.domain}.`, true);
          const r = await egressHelper(['add', c.domain, subs ? '1' : '0', hooks.who], signal);
          if (!r.ok) {
            hooks.note(`✗ dominio ${c.domain} non aperto: ${r.message}`);
            return text(`Non sono riuscito ad aprire ${c.domain}: ${r.message}`, true);
          }
          hooks.note(`dominio aperto nel proxy: ${c.domain}${subs ? ' e sottodomini' : ''}`);
          return text(`${c.domain}${subs ? ' (con i sottodomini)' : ''} è aperto nel proxy da adesso: riprova il comando.`);
        }),
    ],
  });
}
