// Configurazione guidata (Impostazioni › Configurazione): cosa è a posto sul server e cosa manca.
// Il server controlla tutto senza root (server/src/setup.ts); la pagina guida ogni passo (web/src/Setup.tsx).

/** ok: a posto. manca: serve per usare Ciccio. avviso: funziona, ma c'è un rischio o un pezzo spento. facoltativo: in più. */
export type SetupState = 'ok' | 'manca' | 'avviso' | 'facoltativo';

export interface SetupRemedy {
  /** ui: si fa da questa pagina. utente: un comando come utente di Ciccio. root: un passo di deploy/setup.sh. */
  tipo: 'ui' | 'utente' | 'root';
  /** Comando da copiare (utente o root). */
  comando?: string;
  /** Sezione delle Impostazioni o form della pagina che lo sistema (tipo ui). */
  sezione?: string;
}

export interface SetupItem {
  id: string;
  titolo: string;
  stato: SetupState;
  dettaglio: string;
  rimedio: SetupRemedy;
}

export interface SetupReport {
  items: SetupItem[];
  /** Quante voci obbligatorie mancano (stato «manca»). */
  mancano: number;
  /** Quando è stato fatto il controllo (epoch ms). */
  at: number;
  /** Indirizzi da cui si apre Ciccio (CICCIO_ORIGINS): ognuno ha le sue passkey. */
  origini: string[];
}

export interface GithubLoginState {
  state: 'idle' | 'waiting' | 'done' | 'error';
  /** Codice monouso da scrivere su github.com/login/device. */
  code?: string;
  url?: string;
  error?: string;
  login?: string;
}

/** Comando root di un passo di deploy/setup.sh. */
export const rootStep = (step: string) => `sudo bash deploy/setup.sh --step ${step}`;

/**
 * Server SSH come lo vuole l'helper ciccio-ssh-allow: host o host:porta, solo lettere, cifre, punti e trattini,
 * che comincia con una lettera o una cifra (mai un'opzione di ssh). null se va bene, altrimenti il motivo.
 */
export function sshHostError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Scrivi un host, es. server.example.com o server.example.com:2222.';
  const m = /^([A-Za-z0-9][A-Za-z0-9.-]{0,252})(?::(\d{1,5}))?$/.exec(v);
  if (!m) return 'Solo host o host:porta: lettere, cifre, punti e trattini, senza utente né spazi.';
  if (m[1].includes('..') || m[1].endsWith('.') || m[1].endsWith('-')) return 'Nome host non valido.';
  if (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return 'Porta tra 1 e 65535.';
  return null;
}

/** Nome di chi usa Ciccio: lettere, spazi, apostrofi, punti e trattini, al massimo 40 caratteri. */
export function ownerNameError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'Scrivi il tuo nome.';
  if (!/^\p{L}[\p{L}\p{M} '’.-]{0,39}$/u.test(v)) return 'Solo lettere, spazi, apostrofi e trattini (al massimo 40).';
  return null;
}
