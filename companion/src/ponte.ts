import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import { parseBridgeTarget, type BridgeProposal } from '../../shared/companion.js';
import { loadConfig, updateConfig } from './config.js';
import { pcChoose, type PcChoose } from './access.js';
import { clean } from './consensi.js';
import { dim, green, log, yellow } from './log.js';

// Ponti SSH: Ciccio raggiunge un server SSH della rete di questo PC (es. 192.168.1.50 in ufficio) passando da qui.
// Decide il PC, come per 1Password: si apre solo verso le voci "host:porta" esatte di ssh.ponti nella config.
// Una voce nuova la propone Ciccio (l'utente, da Configurazione › Server SSH) e la consente chi è al PC nella
// finestra; un server compromesso può solo proporre, mai aggiungere. Il ponte porta byte e basta: le chiavi SSH
// restano in 1Password, con i loro consensi.
//
// Un nome si risolve qui, sul PC, al momento di aprire, e ci si collega all'indirizzo controllato. Se porta a questo
// PC stesso (loopback, i suoi indirizzi) o a link-local / multicast, no: un nome consentito non diventa una porta
// su servizi del PC solo perché il DNS è cambiato. Per raggiungere il PC stesso si consente l'indirizzo esatto.
// Dove non c'è una finestra (Linux) valgono solo le voci già scritte nella config.

const CONNECT_MS = 10_000;
const ASK_MS = 120_000;
const REFUSED_MS = 10 * 60_000;

/** Indirizzi di questo PC e quelli che non sono «un altro computer della rete». */
function special(addr: string): string | null {
  const a = addr.toLowerCase().replace(/^::ffff:(?=\d+\.)/, '');
  const own = Object.values(os.networkInterfaces()).flat().some((i) => i && i.address.toLowerCase() === a);
  if (own) return 'è un indirizzo di questo PC';
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    if (x === 127) return 'è questo PC (loopback)';
    if (x === 0) return 'non è un indirizzo valido';
    if (x === 169 && y === 254) return 'è link-local';
    if (x >= 224) return 'è multicast o riservato';
    return null;
  }
  if (a === '::1') return 'è questo PC (loopback)';
  if (a === '::') return 'non è un indirizzo valido';
  if (/^fe[89ab]/.test(a)) return 'è link-local';
  if (a.startsWith('ff')) return 'è multicast';
  return null;
}

export class PcBridges {
  private refused = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  /** `configPath` null: nessun ponte (niente config). `choose` null: nessuna finestra, solo la config. */
  constructor(private configPath: string | null, private choose: PcChoose | null = pcChoose() ?? null) {}

  /** Destinazioni consentite, come "host:porta", in ordine e senza doppioni. */
  targets(): string[] {
    if (!this.configPath) return [];
    let list: string[];
    try { list = loadConfig(this.configPath).ssh.ponti; } catch { return []; }
    return [...new Set(list.map((v) => parseBridgeTarget(v)?.key).filter((k): k is string => !!k))];
  }

  /**
   * Apre la connessione TCP verso una destinazione consentita: il socket collegato, o un errore con il motivo.
   * Ci si collega all'indirizzo controllato, non di nuovo al nome.
   */
  async connect(host: unknown, port: unknown): Promise<{ sock: net.Socket; key: string; address: string }> {
    const t = typeof host === 'string' && typeof port === 'number' ? parseBridgeTarget(host, port) : null;
    if (!t) throw new Error('destinazione non valida: serve un nome host o un IPv4 e la porta');
    const allowed = this.targets();
    if (!allowed.includes(t.key)) throw new Error(`${t.key} non è tra i ponti SSH consentiti su questo PC (ssh.ponti nella config del companion)`);
    let address = t.host;
    if (!net.isIPv4(t.host)) {
      let found: { address: string }[];
      try { found = await dns.lookup(t.host, { all: true, verbatim: true }); } catch (e) { throw new Error(`${t.host} non si risolve da questo PC (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`); }
      if (!found.length) throw new Error(`${t.host} non si risolve da questo PC`);
      for (const f of found) {
        const why = special(f.address);
        if (why && !allowed.includes(`${f.address}:${t.port}`)) {
          throw new Error(`${t.host} porta a ${f.address}, che ${why}: ${net.isIPv4(f.address) ? `per un ponte verso quell'indirizzo consenti proprio ${f.address}:${t.port}` : 'ponte rifiutato'}`);
        }
      }
      address = found[0].address;
    }
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: address, port: t.port });
      const timer = setTimeout(() => { s.destroy(); reject(new Error(`${t.key} non risponde entro ${CONNECT_MS / 1000} secondi da questo PC`)); }, CONNECT_MS);
      s.once('connect', () => { clearTimeout(timer); s.removeAllListeners('error'); resolve(s); });
      s.once('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); s.destroy(); reject(new Error(`${t.key} non raggiungibile da questo PC: ${e.code ?? e.message}`)); });
    });
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 60_000);
    return { sock, key: t.key, address };
  }

  /** ssh/bridge-propose: finestra sul PC; «Consenti» scrive la voce in ssh.ponti. */
  async propose(host: unknown, port: unknown, motivo: unknown, signal: AbortSignal): Promise<BridgeProposal> {
    const t = typeof host === 'string' && typeof port === 'number' ? parseBridgeTarget(host, port) : null;
    if (!t) throw new Error('destinazione non valida: serve un nome host o un IPv4 e la porta');
    if (this.targets().includes(t.key)) return 'già';
    if ((this.refused.get(t.key) ?? 0) > Date.now()) { log(dim(`ponte SSH · ${t.key}: rifiutato poco fa sul PC, non lo ripropongo`)); return 'rifiutato'; }
    if (!this.configPath) throw new Error('questo companion non ha una config in cui scrivere i ponti SSH');
    if (!this.choose) throw new Error(`su questo PC non c'è una finestra per confermare: aggiungi "${t.key}" a ssh.ponti nella config del companion`);
    const why = typeof motivo === 'string' ? clean(motivo, 200) : '';
    const warn = net.isIPv4(t.host) ? special(t.host) : null;
    const text = [
      `Ciccio vuole collegarsi in SSH a ${t.key} passando da questo PC. Gli agenti potranno aprire solo quella porta, sempre con le chiavi SSH e i consensi di 1Password.`,
      ...(warn ? [`Attenzione: ${t.host} ${warn}.`] : []),
      ...(why ? [`Nota da Ciccio (non verificata):\n«${why}»`] : []),
      `Si toglie da Ciccio (Configurazione › Server SSH) o da ssh.ponti nella config di questo PC. Senza risposta entro ${ASK_MS / 60_000} minuti: no.`,
    ].join('\n\n');
    log(`ponte SSH · proposta per ${t.key}: chiedo sul PC`);
    const a = await this.ask(text, signal);
    if (a === 'Consenti') {
      updateConfig(this.configPath, (raw) => {
        const ssh = (raw.ssh && typeof raw.ssh === 'object' ? raw.ssh : (raw.ssh = {})) as Record<string, unknown>;
        const list = (Array.isArray(ssh.ponti) ? ssh.ponti : (ssh.ponti = [])) as string[];
        if (!list.some((v) => parseBridgeTarget(v)?.key === t.key)) list.push(t.key);
      });
      log(`ponte SSH · ${t.key}: ${green('consentito')}`);
      return 'consentito';
    }
    if (a === 'No') { this.refused.set(t.key, Date.now() + REFUSED_MS); log(`ponte SSH · ${t.key}: rifiutato`); return 'rifiutato'; }
    log(`ponte SSH · ${t.key}: ${signal.aborted ? 'richiesta annullata' : 'nessuna risposta'}`);
    return 'nessuna_risposta';
  }

  /** ssh/bridge-remove: toglie la voce da ssh.ponti (anche scritta senza porta). true se c'era. */
  remove(host: unknown, port: unknown): boolean {
    const t = typeof host === 'string' && typeof port === 'number' ? parseBridgeTarget(host, port) : null;
    if (!t) throw new Error('destinazione non valida');
    if (!this.configPath || !this.targets().includes(t.key)) return false;
    updateConfig(this.configPath, (raw) => {
      const ssh = raw.ssh as { ponti?: unknown } | undefined;
      if (ssh && Array.isArray(ssh.ponti)) ssh.ponti = ssh.ponti.filter((v) => typeof v !== 'string' || parseBridgeTarget(v)?.key !== t.key);
    });
    log(`ponte SSH · ${t.key}: ${yellow('tolto')} da Ciccio`);
    return true;
  }

  /** Una finestra alla volta; il tempo conta da quando arriva la richiesta. «No» è l'ultimo (Invio, Esc). */
  private ask(text: string, signal: AbortSignal): Promise<string | null> {
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    const timer = setTimeout(stop, ASK_MS);
    signal.addEventListener('abort', stop, { once: true });
    const run = async () => {
      if (ctrl.signal.aborted || !this.choose) return null;
      const gone = new Promise<null>((r) => ctrl.signal.addEventListener('abort', () => r(null), { once: true }));
      return Promise.race([this.choose({ title: 'Ciccio chiede un ponte SSH', text, buttons: ['Consenti', 'No'], timeoutMs: ASK_MS }, ctrl.signal), gone]);
    };
    const p = this.queue.then(run, run).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', stop); ctrl.abort(); });
    this.queue = p.catch(() => undefined);
    return p;
  }
}
