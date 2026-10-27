import { EventEmitter } from 'node:events';
import type { ServerEvent } from '../../shared/types.js';

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export const bus = {
  emit(event: ServerEvent) { emitter.emit('event', event); },
  on(fn: (event: ServerEvent) => void) {
    emitter.on('event', fn);
    return () => emitter.off('event', fn);
  },
};

/** Quanto è costato un giro: dal risultato dell'SDK (sub-agent compresi). */
export interface TurnStats { durationMs: number; tokensIn: number; tokensOut: number; costUsd: number }
/** Messaggio mandato da una routine: esecuzione e nome, per ritrovarla a fine giro. */
export interface RoutineTag { runId: string; name: string }

/** Eventi interni del server (non vanno alla pagina): fine di un giro, avvisi da dare a nome di Ciccio. */
export interface ChatFinished { chatId: string; agentId: string; aborted: boolean; error: string | null; from: 'user' | 'ciccio'; routine?: RoutineTag; stats?: TurnStats }
export interface Notice { agentId: string; chatId: string; text: string; tone: 'done' | 'wait' | 'block' }
/** Un agente scrive a Ciccio (scrivi_a_ciccio): le chat non si parlano tra loro, passa tutto dall'orchestratore. */
export interface ToCiccio { agentId: string; chatId: string; chatTitle: string; text: string }
const internal = new EventEmitter();
export const agentEvents = {
  finished(e: ChatFinished) { internal.emit('finished', e); },
  onFinished(fn: (e: ChatFinished) => void) { internal.on('finished', fn); },
  /** Un avviso nella chat di Ciccio (es. una routine saltata): lo scrive ciccio.ts con le stesse regole degli altri. */
  notice(n: Notice) { internal.emit('notice', n); },
  onNotice(fn: (n: Notice) => void) { internal.on('notice', fn); },
  toCiccio(m: ToCiccio) { internal.emit('toCiccio', m); },
  onToCiccio(fn: (m: ToCiccio) => void) { internal.on('toCiccio', fn); },
};
