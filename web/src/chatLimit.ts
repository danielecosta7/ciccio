import type { ChatView } from '../../shared/types';
import { byWork, recency } from './order';

/** Chat di un progetto che l'elenco mostra finché non chiedi di vedere anche le altre. */
export const CHATS_PER_REPO = 2;

type Item = Pick<ChatView, 'id' | 'running' | 'queued' | 'status' | 'activity' | 'pendingApprovals' | 'lastReply' | 'lastActivity' | 'createdAt'>;

/**
 * Una chat che non si può nascondere perché serve a te: lavora, è in coda, aspetta una tua risposta
 * (permesso o domanda) oppure si è fermata con un errore. Un giro che sta per partire o finire cambia questi campi:
 * la chat entra nell'elenco appena serve e può uscirne solo quando non serve più.
 */
export const needsSight = (c: Item): boolean =>
  c.running || c.queued || c.activity !== 'idle' || c.pendingApprovals > 0 || c.status === 'work' || c.status === 'wait' || c.status === 'block';

/**
 * Quali chat di un progetto mostrare a elenco chiuso: sempre quella aperta e tutte quelle che servono (`needsSight`),
 * poi, fino al limite, le più recenti. Se le chat che servono sono già più del limite, il limite cresce con loro:
 * nessuna chat al lavoro o in attesa resta nascosta.
 * Le chat tornano nell'ordine di lavorazione (`byWork`), lo stesso dell'elenco intero, così aprire l'elenco
 * aggiunge righe senza spostare quelle già visibili.
 */
export function visibleChats<T extends Item>(chats: readonly T[], opts: { currentId?: string | null; limit?: number } = {}): { shown: T[]; hidden: number } {
  const limit = Math.max(0, opts.limit ?? CHATS_PER_REPO);
  const sorted = [...chats].sort(byWork);
  if (sorted.length <= limit) return { shown: sorted, hidden: 0 };

  const keep = new Set(sorted.filter((c) => c.id === opts.currentId || needsSight(c)).map((c) => c.id));
  // Una chat nuova, mai usata, conta dal giorno in cui è nata: non sparisce subito dietro quelle vecchie.
  const fresh = (c: Item) => Math.max(recency(c), c.createdAt);
  for (const c of [...sorted].sort((x, y) => fresh(y) - fresh(x))) {
    if (keep.size >= limit) break;
    keep.add(c.id);
  }
  const shown = sorted.filter((c) => keep.has(c.id));
  return { shown, hidden: sorted.length - shown.length };
}
