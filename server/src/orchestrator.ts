import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { agentEvents } from './bus.js';
import { OWNER } from './config.js';

// Strumento degli agenti per parlare con Ciccio, l'orchestratore. Le chat non si scrivono tra loro: se a un agente
// serve un altro progetto o una decisione di coordinamento, lo chiede a Ciccio, che risponde in questa chat
// (scrivi_ad_agente), coinvolge un'altra chat o chiede all'utente. Ciccio si sveglia solo quando arriva un messaggio:
// nessun controllo in sottofondo, nessun token in più finché nessuno scrive.

export const ORCHESTRATOR_SERVER = 'ciccio_orchestratore';
export const TO_CICCIO_TOOL = `mcp__${ORCHESTRATOR_SERVER}__scrivi_a_ciccio`;

export function orchestratorServer(who: { agentId: string; chatId: string; chatTitle: string }): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: ORCHESTRATOR_SERVER,
    version: '1.0.0',
    tools: [
      tool('scrivi_a_ciccio',
        `Scrive a Ciccio, l'orchestratore di ${OWNER}, che coordina tutti i progetti. Usalo quando ti serve qualcosa da un altro progetto o da un'altra chat (le chat non si parlano tra loro), o una decisione che riguarda più progetti. ` +
        `Ciccio risponde in questa chat se serve. Non usarlo per aggiornamenti normali: quando finisci un giro Ciccio lo sa già. Le domande per ${OWNER} falle a lui in chat, non a Ciccio.`,
        { messaggio: z.string().min(3).max(3000).describe('cosa ti serve, chiaro e completo: Ciccio non vede questa conversazione') },
        async ({ messaggio }) => {
          agentEvents.toCiccio({ ...who, text: messaggio });
          return { content: [{ type: 'text' as const, text: 'Passato a Ciccio. Se serve, ti risponde in questa chat con un messaggio nuovo: intanto vai avanti con il resto.' }] };
        }),
    ],
  });
}
