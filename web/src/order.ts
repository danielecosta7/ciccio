import type { AgentStatus } from '../../shared/types';

/** Ora dell'ultima risposta, o dell'ultima attività se l'agente non ha mai risposto. */
export const recency = (x: { lastReply: number | null; lastActivity: number | null }) => x.lastReply ?? x.lastActivity ?? 0;

// Ordine di lavorazione, uguale in dashboard e nella colonna dei progetti: in cima chi sta lavorando (o è in coda),
// poi chi ti aspetta, poi gli altri; a parità, dal più recente. L'ora dell'ultima risposta da sola lasciava sotto
// un agente al lavoro da un pezzo con i soli strumenti, dietro uno fermo da giorni.
type Ranked = { running: boolean; queued: boolean; status: AgentStatus; lastReply: number | null; lastActivity: number | null };
const rank = (x: Ranked) => (x.running || x.queued ? 0 : x.status === 'wait' ? 1 : 2);
export const byWork = (x: Ranked, y: Ranked) => rank(x) - rank(y) || recency(y) - recency(x);
