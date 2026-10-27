import fs from 'node:fs';
import { execFile } from 'node:child_process';

// Domini del proxy in uscita (tinyproxy, deploy/egress-firewall.sh): gli agenti raggiungono internet solo da lì.
// Un agente può chiederne uno nuovo (consenti_dominio): Ciccio controlla il nome, l'utente approva ogni volta,
// e solo dopo l'helper root /usr/local/sbin/ciccio-egress-allow (deploy/ciccio-egress-allow.sh) lo aggiunge,
// rifacendo da sé tutti i controlli. Gli aggiunti stanno in /etc/ciccio/egress-extra e si tolgono dalle Impostazioni.

const FILTER = '/etc/tinyproxy/ciccio-allow';
const EXTRA = '/etc/ciccio/egress-extra';
const HELPER = '/usr/local/sbin/ciccio-egress-allow';

/** Nome host semplice: etichette con lettere, cifre e trattini, almeno un punto, primo livello di sole lettere. */
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL = /(^|\.)(localhost|local|internal|lan|home|arpa|corp|intranet|ts\.net)$/;
const PUBLIC_SUFFIX = /^(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;

/** Il dominio pulito da un indirizzo o da un nome (https://Export-Download.canva.com/x → export-download.canva.com), o un errore. */
export function cleanDomain(raw: string, subdomains: boolean): { domain: string } | { error: string } {
  let d = raw.trim().toLowerCase();
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(d)) d = new URL(d).hostname; } catch { /* resta com'era */ }
  d = d.replace(/^\*\./, '').replace(/\.$/, '');
  if (/^\d+(\.\d+){3}$/.test(d) || d.includes(':')) return { error: 'Servono nomi di dominio, non indirizzi IP.' };
  if (!HOST.test(d)) return { error: `«${raw.slice(0, 80)}» non è un nome di dominio semplice (es. export-download.canva.com): niente porte, percorsi o caratteri jolly.` };
  if (LOCAL.test(d)) return { error: 'Nomi locali o della rete interna non si aprono dal proxy.' };
  if (subdomains && PUBLIC_SUFFIX.test(d)) return { error: `I sottodomini si aprono solo per un dominio preciso, non per ${d}.` };
  return { domain: d };
}

function patterns(): RegExp[] {
  try {
    return fs.readFileSync(FILTER, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .flatMap((l) => { try { return [new RegExp(l, 'i')]; } catch { return []; } });
  } catch { return []; }
}

/** Il proxy lascia già passare questo dominio? */
export const domainAllowed = (domain: string) => patterns().some((r) => r.test(domain));

export interface EgressDomain { domain: string; subdomains: boolean; who: string; at: string }

/** Domini aggiunti su richiesta degli agenti (non quelli fissi dello script del firewall). */
export function extraDomains(): EgressDomain[] {
  try {
    return fs.readFileSync(EXTRA, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
      const [pattern, domain, who, at] = l.split('\t');
      return { domain, subdomains: pattern.startsWith('(^|'), who: who ?? '—', at: at ?? '' };
    }).filter((x) => x.domain);
  } catch { return []; }
}

/** Quanti domini fissi ha l'elenco del proxy (solo per le Impostazioni). */
export function baseCount(): number {
  try { return fs.readFileSync('/etc/tinyproxy/ciccio-allow-base', 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length; } catch { return patterns().length; }
}

/** Lancia l'helper root: ultima riga OK/GIA/TOLTO <dominio> o ERRORE <motivo>. */
export function egressHelper(args: string[], signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    execFile('sudo', ['-n', HELPER, ...args], { timeout: 60_000, signal, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      const last = out.split('\n').pop() ?? '';
      if (!err && /^(OK|GIA|TOLTO) /.test(last)) return resolve({ ok: true, message: last });
      const reason = last.startsWith('ERRORE ') ? last.slice(7)
        : /password is required|not allowed|may not run sudo|no new privileges|command not found|No such file/i.test(out) ? 'i domini nuovi dal server non sono attivi (manca l\'helper ciccio-egress-allow): va attivato con deploy/egress-helper.sh'
          : last.slice(0, 200) || (err?.message ?? 'errore');
      resolve({ ok: false, message: reason });
    });
  });
}
