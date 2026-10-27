import path from 'node:path';
import os from 'node:os';
import { setTimeZone, timeZone, validZone } from '../../shared/tz.js';
import Database from 'better-sqlite3';

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  /** Indirizzo su cui ascoltare: 127.0.0.1, con davanti `tailscale serve` (o Caddy per un dominio pubblico). */
  host: process.env.CICCIO_HOST ?? '127.0.0.1',
  port: num('CICCIO_PORT', 8787),
  /** Cartella con un clone per progetto. */
  projectsDir: process.env.CICCIO_PROJECTS_DIR ?? path.join(os.homedir(), 'projects'),
  dataDir: process.env.CICCIO_DATA_DIR ?? path.join(os.homedir(), '.ciccio'),
  /** Sessioni agente attive insieme; le altre restano in coda. */
  maxActive: num('CICCIO_MAX_ACTIVE', 5),
  /** Giorni senza attività dopo cui un progetto con lavoro aperto è "fermo". */
  staleDays: num('CICCIO_STALE_DAYS', 7),
  agentModel: process.env.CICCIO_AGENT_MODEL ?? 'claude-opus-5-5',
  ciccioModel: process.env.CICCIO_MODEL ?? 'claude-opus-5-5',
  webDir: process.env.CICCIO_WEB_DIR ?? path.resolve(import.meta.dirname, '../../web'),
  /** Ora (nel fuso di tz) in cui Ciccio prepara il riepilogo del giorno. */
  recapHour: num('CICCIO_RECAP_HOUR', 5),
  /** Fuso orario di routine, riepilogo e giorni dei consumi (es. Europe/Rome); di serie quello del sistema. */
  tz: zone(),
  /**
   * Indirizzi https da cui si apre Ciccio (passkey e controllo dell'origine), separati da virgola: di solito quello
   * di Tailscale (`tailscale serve`, https://<server>.<tailnet>.ts.net), più un dominio pubblico se c'è. Il primo è
   * quello dei link. In sviluppo, senza variabile, l'interfaccia di Vite.
   */
  origins: origins(),
  /**
   * Proxy da cui leggere l'indirizzo vero del client (X-Forwarded-For), separati da virgola: IP, reti (100.64.0.0/10) o
   * «loopback». Di base solo 127.0.0.1 e ::1 (tailscale serve, o Caddy sulla stessa macchina verso 127.0.0.1). Se Caddy
   * arriva a Ciccio dall'IP Tailscale, quell'IP. Gli altri X-Forwarded-For non contano: li scrive chiunque.
   */
  trustProxy: (process.env.CICCIO_TRUST_PROXY ?? 'loopback').split(',').map((s) => s.trim()).filter(Boolean),
  /**
   * Dove sta il codice sorgente di questo Ciccio: il link «Codice sorgente» nella pagina di accesso e nelle
   * Impostazioni (AGPL-3.0, sezione 13). Chi offre ad altri una versione modificata ci mette l'indirizzo della sua.
   */
  sourceUrl: sourceUrl(),
};

function sourceUrl(): string {
  const fallback = 'https://github.com/danielecosta7/ciccio';
  const raw = process.env.CICCIO_SOURCE_URL?.trim();
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.href.replace(/\/+$/, '');
  } catch { /* sotto */ }
  console.warn(`CICCIO_SOURCE_URL=${raw} non è un indirizzo http(s): uso ${fallback}.`);
  return fallback;
}

function zone(): string {
  const raw = process.env.CICCIO_TZ;
  const tz = validZone(raw);
  if (raw && !tz) console.warn(`CICCIO_TZ=${raw} non è un fuso orario valido: uso ${timeZone()}.`);
  if (tz) setTimeZone(tz);
  return timeZone();
}

function origins(): string[] {
  const raw = process.env.CICCIO_ORIGINS ?? process.env.CICCIO_PUBLIC_ORIGIN ?? 'http://localhost:5173';
  return raw.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean).map((o) => new URL(o).origin);
}

/**
 * Nome cambiato da Impostazioni › Configurazione (chiave owner_name del database). Si legge una volta all'avvio:
 * i prompt degli agenti lo usano già al caricamento dei moduli, quindi un nome nuovo vale dal riavvio dopo.
 */
function savedOwner(): string | undefined {
  try {
    const db = new Database(path.join(config.dataDir, 'ciccio.db'), { fileMustExist: true });
    try {
      const row = db.prepare(`SELECT value FROM kv WHERE key = 'owner_name'`).get() as { value: string } | undefined;
      const v: unknown = row ? JSON.parse(row.value) : null;
      return typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : undefined;
    } finally { db.close(); }
  } catch { return undefined; }
}

/** Nome di chi usa Ciccio: gli agenti e Ciccio gli parlano e scrivono di lui con questo nome. CICCIO_OWNER_NAME è quello di partenza. */
export const OWNER = savedOwner() || process.env.CICCIO_OWNER_NAME?.trim() || 'Utente';

/** Indirizzo principale, per i link che escono da Ciccio (notifiche, companion, documenti). */
export const mainOrigin = config.origins[0];

/**
 * Variabili del servizio che passano alle sessioni Claude: solo quelle che servono al processo di Claude Code
 * (percorsi, lingua, proxy, certificati, accesso ad Anthropic, sue opzioni) e a git/gh, più quelle di Windows
 * per le prove sul PC. Niente CICCIO_* né altre
 * chiavi messe in ciccio.env: i comandi degli agenti ereditano l'ambiente della sessione.
 */
const CLAUDE_ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|TMPDIR|https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|GH_TOKEN|GITHUB_TOKEN|GH_HOST|ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_[A-Z0-9_]+|CLAUDE_CONFIG_DIR|DISABLE_[A-Z0-9_]+|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PATHEXT|TEMP|TMP|USERPROFILE|USERNAME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES|COMPUTERNAME|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i;

/**
 * Credenziali di Anthropic: le usa il processo di Claude Code, mai i comandi che lancia. Si tolgono ai comandi
 * nella sandbox (sandbox.credentials, vedi withoutClaudeCredentials).
 */
export const CLAUDE_AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN'];

/**
 * Accessi a consumo che Ciccio non usa: le sessioni girano solo con il login di claude.ai dell'utente (vedi usage.ts).
 * Se uno è nell'ambiente del servizio non passa alle sessioni, che altrimenti lo preferirebbero al login.
 */
const PAY_PER_USE_VARS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/;

function keptEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null && CLAUDE_ENV_KEEP.test(k) && !PAY_PER_USE_VARS.test(k)) out[k] = v;
  return out;
}

/**
 * Sandbox dei comandi con le credenziali di Anthropic tolte dall'ambiente (si aggiungono a quelle che la sandbox
 * nega già). CLAUDE_CODE_SUBPROCESS_ENV_SCRUB farebbe lo stesso anche per hook e server MCP, ma toglie anche
 * SSH_AUTH_SOCK, e con lui le chiavi SSH della chat.
 */
export function withoutClaudeCredentials<T extends { credentials?: { envVars?: { name: string; mode: 'deny' | 'mask' }[] } }>(sandbox: T): T {
  const envVars = sandbox.credentials?.envVars ?? [];
  const extra = CLAUDE_AUTH_VARS.filter((name) => !envVars.some((v) => v.name === name)).map((name) => ({ name, mode: 'deny' as const }));
  return { ...sandbox, credentials: { ...sandbox.credentials, envVars: [...envVars, ...extra] } };
}

/**
 * Ambiente delle sessioni Claude: niente telemetria o segnalazioni di errore verso terzi.
 * I connettori di claude.ai (Gmail, Notion…) li accende ogni sessione quando servono.
 */
export const claudeEnv: Record<string, string | undefined> = {
  ...keptEnv(),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
};
