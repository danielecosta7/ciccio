import { COMPANION_PATH } from '../../shared/companion.js';

// Abbinamento con un clic: il pulsante "Collega questo PC" in Ciccio apre
// ciccio-companion://pair?token=…&server=… (come l'app del Mac). Un link da un altro sito non può
// dirottare gli strumenti di questo PC verso un server suo:
// - PC già collegato: il link vale solo per il server della config (per cambiarlo serve init --server);
// - prima volta: solo https (http solo verso questo computer, per le prove) e sempre dopo una conferma
//   che mostra l'indirizzo; --yes la salta, ma si scrive solo a mano in un terminale (il link del
//   browser non lo passa mai).

/** Origine di un indirizzo di Ciccio (https://host[:porta]), o null se non è un indirizzo http(s). */
export function normServer(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch { return null; }
}

const loopback = (u: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);

export interface PairLink { token: string; server: string; /** Primo collegamento: nessun server nella config. */ first: boolean }

/** `current`: il server nella config di questo PC ('' se non è ancora collegato). */
export function parsePairLink(raw: string, current: string): PairLink {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('Link di abbinamento non valido.'); }
  if (url.protocol !== 'ciccio-companion:' || (url.hostname || url.pathname.replace(/^\/+/, '')) !== 'pair') {
    throw new Error('Link di abbinamento non valido.');
  }
  const token = url.searchParams.get('token') ?? '';
  const rawServer = url.searchParams.get('server') ?? '';
  const server = normServer(rawServer);
  if (!/^ccp_[\w-]{20,}$/.test(token)) throw new Error('Il link non contiene un token valido.');
  if (!server) throw new Error(`Server non riconosciuto (${rawServer || 'nessuno'}): il link non contiene un indirizzo valido.`);
  const known = current ? normServer(current) : null;
  if (known) {
    if (server !== known) {
      throw new Error(`Server non riconosciuto (${new URL(server).host}): questo PC è collegato a ${new URL(known).host}. Per cambiare server, da terminale: ciccio-companion init <token> --server <indirizzo>.`);
    }
    return { token, server, first: false };
  }
  if (new URL(server).protocol !== 'https:' && !loopback(new URL(server))) {
    throw new Error(`Server non riconosciuto (${new URL(server).host}): serve un indirizzo https.`);
  }
  return { token, server, first: true };
}

/** Testo della conferma: la prima volta l'indirizzo è la cosa da controllare. */
export function pairQuestion(p: PairLink): { title: string; body: string } {
  const host = new URL(p.server).host;
  return p.first
    ? { title: `Collegare questo PC a ${host}?`, body: `Collega solo se ${host} è l'indirizzo del tuo Ciccio: gli agenti di quel server potranno usare Affinity e Chrome di questo PC, sempre con i permessi della chat.` }
    : { title: 'Collegare questo PC a Ciccio?', body: `Gli agenti potranno usare Affinity e Chrome di questo PC (${host}), sempre con i permessi della chat.` };
}

/** Il token vale davvero? Ciccio risponde 401 a un token sconosciuto, prima ancora della WebSocket. */
export async function checkToken({ token, server }: Pick<PairLink, 'token' | 'server'>): Promise<'ok' | 'rejected' | 'unreachable'> {
  try {
    const res = await fetch(new URL(COMPANION_PATH, server), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    return res.status === 401 || res.status === 403 ? 'rejected' : 'ok';
  } catch {
    return 'unreachable';
  }
}
