import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { SUBAGENT_MODELS, type SubagentModel } from '../../shared/types.js';

// Modello dei sub-agent: l'utente sceglie nelle Impostazioni quali sono consentiti; un hook PreToolUse
// sullo strumento Agent sostituisce il modello chiesto dall'agente con il più vicino tra quelli consentiti.
// (Provato sul server: con updatedInput il sub-agent gira davvero con il modello nuovo; canUseTool per
// lo strumento Agent non viene chiamato, quindi l'hook è l'unico punto dove intervenire.)

const RANK: Record<SubagentModel, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 3 };

/**
 * Modello da dare al sub-agent, o null se va bene quello chiesto.
 * - chiesto e consentito: resta;
 * - chiesto e non consentito: il consentito più vicino per «forza» (a pari distanza il più forte);
 * - non indicato: il sub-agent erediterebbe il modello della chat (di solito Opus), quindi se Opus non è
 *   consentito si sceglie il più vicino a Sonnet; per Explore, che è fatto per cercare in fretta, a Haiku.
 */
export function pickSubagentModel(requested: unknown, subagentType: unknown, allowed: SubagentModel[]): SubagentModel | null {
  const ok = allowed.length ? allowed : SUBAGENT_MODELS.map((m) => m.id);
  const asked = SUBAGENT_MODELS.some((m) => m.id === requested) ? (requested as SubagentModel) : null;
  if (asked && ok.includes(asked)) return null;
  if (!asked && (ok.includes('opus') || ok.includes('fable'))) return null;
  const target = asked ? RANK[asked] : subagentType === 'Explore' ? RANK.haiku : RANK.sonnet;
  return [...ok].sort((a, b) => Math.abs(RANK[a] - target) - Math.abs(RANK[b] - target) || RANK[b] - RANK[a])[0];
}

/** Hook da passare a query(): legge i modelli consentiti a ogni chiamata, così un cambio vale subito. */
export function subagentModelHook(allowed: () => SubagentModel[], onSwap?: (from: string, to: SubagentModel) => void): Partial<Record<'PreToolUse', HookCallbackMatcher[]>> {
  return {
    PreToolUse: [{
      matcher: 'Agent|Task',
      hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
        // I fork ereditano sempre il modello della chat: il campo model lì non conta.
        if (toolInput.subagent_type === 'fork') return {};
        const model = pickSubagentModel(toolInput.model, toolInput.subagent_type, allowed());
        if (!model) return {};
        onSwap?.(typeof toolInput.model === 'string' ? toolInput.model : 'quello della chat', model);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...toolInput, model } } };
      }],
    }],
  };
}
