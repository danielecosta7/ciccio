// Tempo dedicato a una chat o a un progetto, ricavato dai messaggi delle chat: restano tutti nel database,
// quindi il conto parte dal primo giorno, senza un registro a parte.
//
// Stesso limite di Impostazioni › Consumi: le pause fino a IDLE_GAP_MS tra un messaggio e il successivo contano,
// quelle più lunghe no (eri altrove). In più non contano i giri partiti da soli (routine, Ciccio): lì non c'è
// nessuno davanti allo schermo. Per un progetto gli eventi di tutte le sue chat si contano in una sola sequenza:
// due chat al lavoro nello stesso momento fanno un'ora, non due.

import { IDLE_GAP_MS } from './consumi.js';
import { timeZone } from './tz.js';

/** Un messaggio di una chat: quando, e chi ha aperto il giro se è il messaggio che lo apre. */
export interface WorkEvent { ts: number; start: 'user' | 'auto' | null }

export interface WorkTime {
  /** Questa chat, da sempre. */
  chatMs: number;
  /** Tutto il progetto (tutte le sue chat), da sempre. */
  projectMs: number;
  /** Il progetto dall'inizio di oggi (fuso di Ciccio). */
  todayMs: number;
  /** Il progetto negli ultimi 7 giorni. */
  weekMs: number;
}

/** Mezzanotte di oggi nel fuso di Ciccio. */
export function startOfDay(now: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone(), hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(now));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return now - (((n('hour') * 60 + n('minute')) * 60 + n('second')) * 1000 + (now % 1000));
}

/** Tempo attivo di una sequenza di eventi in ordine di tempo; con `since` solo le pause che finiscono da quel momento in poi. */
export function activeMs(events: WorkEvent[], since = 0): number {
  let total = 0, auto = false, prev = 0;
  for (const e of events) {
    if (e.start) auto = e.start === 'auto';
    const gap = e.ts - prev;
    if (prev && !auto && gap > 0 && gap <= IDLE_GAP_MS && e.ts >= since) total += gap;
    if (e.ts > prev) prev = e.ts;
  }
  return total;
}

export function workTime(chat: WorkEvent[], project: WorkEvent[], now = Date.now()): WorkTime {
  return {
    chatMs: activeMs(chat),
    projectMs: activeMs(project),
    todayMs: activeMs(project, startOfDay(now)),
    weekMs: activeMs(project, now - 7 * 86_400_000),
  };
}
