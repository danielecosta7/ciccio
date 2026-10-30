import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { cleanDomain, domainAllowed, egressHelper } from './egress.js';
import { OWNER, config } from './config.js';

// installa_programma: l'agente chiede un programma di sistema (pacchetto ufficiale di Ubuntu) che manca sul server.
// Prima Ciccio controlla, senza root, che il pacchetto esista e cosa porterebbe con sé; poi chiede SEMPRE
// all'utente (in ogni livello, «Salta permessi» compreso, mai «sempre»); solo dopo il suo sì lancia con sudo
// l'helper root /usr/local/sbin/ciccio-apt-install (deploy/apt-helper.sh), che rifà tutti i controlli da sé.
//
// installa_da_url: quando il programma non è nei repository di Ubuntu (es. FreeCAD) l'agente indica un indirizzo https
// di una AppImage o di un archivio tar. Stessa regola: l'utente vede indirizzo, nome e comandi e approva ogni volta;
// poi Ciccio scarica come utente normale, calcola lo sha256 e lancia l'helper root ciccio-app-install
// (deploy/app-helper.sh), che estrae senza eseguire niente e mette tutto in /opt/ciccio-app/<nome>.

export const SYSTEM_SERVER = 'ciccio_sistema';
export const INSTALL_TOOL = `mcp__${SYSTEM_SERVER}__installa_programma`;
export const INSTALL_URL_TOOL = `mcp__${SYSTEM_SERVER}__installa_da_url`;
export const EGRESS_TOOL = `mcp__${SYSTEM_SERVER}__consenti_dominio`;
const HELPER = '/usr/local/sbin/ciccio-apt-install';
const APP_HELPER = '/usr/local/sbin/ciccio-app-install';
const APP_DIR = '/opt/ciccio-app';
const MAX_DOWNLOAD = 4 * 1024 ** 3;
const DOWNLOAD_MS = 25 * 60_000;

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

/** Nome del programma: la cartella in /opt/ciccio-app. */
export const APP_NAME = /^[a-z0-9][a-z0-9-]{1,30}$/;
const CMD_NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/;
const CMD_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/+-]{1,200}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** AppImage o archivio tar, dal nome del file nell'indirizzo (senza query); null se non è né l'uno né l'altro. */
export function appKind(url: URL): 'appimage' | 'tar' | null {
  let file: string;
  try { file = decodeURIComponent(url.pathname).toLowerCase(); } catch { return null; }
  if (file.endsWith('.appimage')) return 'appimage';
  return /\.(tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2)$/.test(file) ? 'tar' : null;
}

/** Indirizzo interno (rete locale, loopback, link-local, CGNAT): il server non scarica da lì per conto di un agente. */
export function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

/** Nome pubblico e raggiungibile: niente IP, nomi locali o nomi che puntano a indirizzi interni. Un errore, o null. */
async function hostProblem(host: string): Promise<string | null> {
  const c = cleanDomain(host, false);
  if ('error' in c) return c.error;
  try {
    const addrs = await dns.lookup(c.domain, { all: true });
    if (!addrs.length || addrs.some((a) => privateIp(a.address))) return `${c.domain} punta a un indirizzo interno: da lì non si scarica.`;
  } catch { return `${c.domain} non si risolve.`; }
  return null;
}

/** Scarica in `dest` seguendo al massimo 5 rimandi, solo https e solo verso nomi pubblici; calcola lo sha256 mentre scrive. */
async function download(first: URL, dest: string, signal: AbortSignal): Promise<{ sha256: string; bytes: number; host: string } | { error: string }> {
  let url = first;
  for (let hop = 0; hop < 6; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return { error: 'Servono indirizzi https normali (porta 443, senza utente e password), anche nei rimandi.' };
    const bad = await hostProblem(url.hostname);
    if (bad) return { error: bad };
    const res = await fetch(url, { redirect: 'manual', signal, headers: { 'user-agent': 'ciccio' } });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      await res.body?.cancel();
      try { url = new URL(next ?? '', url); } catch { return { error: 'Il sito rimanda a un indirizzo che non capisco.' }; }
      continue;
    }
    if (!res.ok || !res.body) return { error: `${url.hostname} ha risposto ${res.status}.${res.status === 403 || res.status === 502 ? ' Se è il proxy in uscita a rifiutare, apri il dominio con consenti_dominio e riprova.' : ''}` };
    if (Number(res.headers.get('content-length')) > MAX_DOWNLOAD) return { error: 'Il file è oltre 4 GB.' };
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > MAX_DOWNLOAD) return cb(new Error('il file è oltre 4 GB'));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try { await pipeline(Readable.fromWeb(res.body as never), meter, fs.createWriteStream(dest, { mode: 0o600 }), { signal }); }
    catch (e) { return { error: `Download interrotto: ${(e as Error).message}` }; }
    return { sha256: hash.digest('hex'), bytes, host: url.hostname };
  }
  return { error: 'Troppi rimandi.' };
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
      tool('installa_da_url',
        'Chiede di installare sul server un programma che NON è nei repository di Ubuntu (es. FreeCAD, che esce come AppImage), scaricandolo da un indirizzo https: ' +
        `una AppImage (.AppImage) o un archivio (.tar.gz, .tar.xz, .tar.bz2). ${OWNER} approva ogni installazione in Ciccio vedendo indirizzo, nome e comandi; tu non puoi usare sudo. ` +
        `Il programma va in ${APP_DIR}/<nome>, estratto senza eseguire niente (per le AppImage serve squashfs-tools: chiedilo con installa_programma). ` +
        'I comandi che indichi diventano link in /usr/local/bin (mai su comandi di sistema). Per le AppImage il punto d\'ingresso è AppRun, che accetta gli argomenti del programma; ' +
        'se non conosci il percorso di un eseguibile interno, non indicare comandi: l\'esito elenca gli eseguibili trovati e li lanci da ' + `${APP_DIR}/<nome>/…. ` +
        'Preferisci sempre installa_programma quando il pacchetto Ubuntu esiste. Dopo, i comandi che usano il programma seguono il livello di autorizzazione della chat come gli altri.',
        {
          nome: z.string().max(40).describe('nome del programma, es. freecad (minuscole, cifre, trattini): è la cartella in /opt/ciccio-app'),
          url: z.string().max(500).describe('indirizzo https diretto del file, es. la AppImage ufficiale della release su GitHub (niente pagine web da cui scegliere)'),
          comandi: z.array(z.object({
            nome: z.string().max(41).describe('nome del comando da avere in /usr/local/bin, es. freecadcmd'),
            percorso: z.string().max(200).optional().describe('percorso relativo nel programma, es. usr/bin/freecadcmd; per una AppImage di norma AppRun (predefinito)'),
          })).max(8).optional().describe('comandi da collegare; vuoto se non conosci i percorsi'),
          tipo: z.enum(['appimage', 'tar']).optional().describe("solo se l'indirizzo non finisce con .AppImage o .tar.*"),
          sha256: z.string().max(64).optional().describe('sha256 atteso del file, se lo conosci (di norma lo pubblica il progetto): il download è rifiutato se non corrisponde'),
          motivo: z.string().min(3).max(300).describe(`a cosa ti serve, in una riga: lo legge ${OWNER} quando approva`),
        },
        async ({ nome, url, comandi, tipo, sha256, motivo }) => {
          const name = nome.trim();
          if (!APP_NAME.test(name)) return text(`Nome non valido: «${nome.slice(0, 40)}». Minuscole, cifre e trattini (2-31 caratteri), es. freecad.`, true);
          if (process.platform !== 'linux') return text('Installare programmi si può solo sul server Linux di Ciccio.', true);
          let u: URL;
          try { u = new URL(url.trim()); } catch { return text('L\'indirizzo non è valido: serve un indirizzo https completo.', true); }
          if (u.protocol !== 'https:') return text('Si scarica solo da indirizzi https.', true);
          const kind = tipo ?? appKind(u);
          if (!kind) return text('Non riconosco il tipo di file dall\'indirizzo: serve una AppImage (.AppImage) o un archivio .tar.gz, .tar.xz, .tar.bz2 (oppure indica `tipo`). I pacchetti .deb e gli script di installazione non si usano: girerebbero come root.', true);
          const want = sha256?.trim().toLowerCase();
          if (want && !SHA256.test(want)) return text('Lo sha256 deve essere di 64 cifre esadecimali.', true);
          const links: { nome: string; percorso: string }[] = [];
          for (const c of comandi ?? []) {
            const percorso = (c.percorso ?? (kind === 'appimage' ? 'AppRun' : '')).trim();
            if (!CMD_NAME.test(c.nome)) return text(`Nome di comando non valido: «${c.nome.slice(0, 41)}» (minuscole, cifre, . _ -).`, true);
            if (!CMD_PATH.test(percorso)) return text(`Percorso non valido per ${c.nome}: ${percorso ? `«${percorso.slice(0, 80)}»` : 'serve, per gli archivi'} (relativo, senza «..»).`, true);
            links.push({ nome: c.nome, percorso });
          }
          const bad = await hostProblem(u.hostname);
          if (bad) return text(bad, true);
          const have = await exec('test', ['-f', `${APP_DIR}/${name}/.ciccio-app`], 5_000, signal);
          const ok = await hooks.ask(INSTALL_URL_TOOL, {
            nome: name, url: u.toString(), tipo: kind, comandi: links.map((l) => `${l.nome} → ${l.percorso}`), sha256: want, motivo, sostituisce: have.code === 0,
          }, `programma scaricato da ${u.hostname} e messo come root in ${APP_DIR}/${name}${have.code === 0 ? ' (sostituisce la versione già installata)' : ''}; lo approvi solo tu`);
          if (!ok) return text(`${OWNER} non ha approvato l'installazione di ${name}.`, true);

          const stage = fs.mkdtempSync(path.join(config.dataDir, 'app-'));
          try {
            const file = path.join(fs.realpathSync(stage), 'file');
            hooks.note(`scarico ${name} da ${u.hostname}…`);
            const got = await download(u, file, AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_MS)]));
            if ('error' in got) { hooks.note(`✗ download di ${name} non riuscito: ${got.error}`); return text(`Download di ${name} non riuscito: ${got.error}`, true); }
            if (want && got.sha256 !== want) {
              hooks.note(`✗ ${name}: lo sha256 non corrisponde`);
              return text(`Lo sha256 del file scaricato (${got.sha256}) non corrisponde a quello indicato (${want}): non installo.`, true);
            }
            const args = [name, kind, file, got.sha256, links.length ? links.map((l) => `${l.nome}=${l.percorso}`).join(',') : '-', `${hooks.who} · ${got.host}`];
            const r = await exec('sudo', ['-n', APP_HELPER, ...args], 20 * 60_000, signal);
            const lines = r.out.trim().split('\n');
            const last = lines.pop() ?? '';
            const m = /^OK (\S+) (\d+) comandi$/.exec(last);
            if (r.code === 0 && m) {
              const extra = lines.filter((l) => /^(AVVISO|ESEGUIBILI:)/.test(l)).join('\n');
              hooks.note(`installato ${name} (${Math.round(got.bytes / 1048576)} MB, ${m[2]} comandi)`);
              return text(`Installato ${name} in ${APP_DIR}/${name} (sha256 ${got.sha256.slice(0, 12)}…). ${m[2]} comandi collegati in /usr/local/bin${links.length ? `: ${links.map((l) => l.nome).join(', ')}` : ''}.${extra ? `\n${extra}` : ''}\nI comandi che lo usano seguono il livello di autorizzazione della chat.`);
            }
            const reason = last.startsWith('ERRORE ') ? last.slice(7)
              : /password is required|not allowed|may not run sudo|no new privileges|command not found|No such file/i.test(r.out) ? "l'installazione di programmi scaricati non è attiva (manca l'helper ciccio-app-install): va attivata con deploy/app-helper.sh"
              : last.slice(0, 200) || `uscita ${r.code}`;
            hooks.note(`✗ installazione di ${name} non riuscita: ${reason}`);
            return text(`Installazione di ${name} non riuscita: ${reason}`, true);
          } finally {
            fs.rmSync(stage, { recursive: true, force: true });
          }
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
