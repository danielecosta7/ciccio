import path from 'node:path';
import { ASK_TOOL, type PermissionLevel } from '../../shared/types.js';
import { OWNER } from './config.js';

// Politica degli agenti: autonomi per default. Solo poche azioni pericolose vengono
// bloccate o chiedono conferma all'utente. Il firewall in uscita limita comunque la rete.

export type Verdict = { action: 'allow' } | { action: 'ask'; reason: string } | { action: 'deny'; reason: string };

/** Cosa si sa di uno strumento oltre al nome: se il server MCP lo dichiara di sola lettura (true) o un'azione (false). */
export interface ToolHints { readOnly?: boolean }

const DENY: { test: RegExp; reason: string }[] = [
  { test: /\bgit\s+push\b[^|;&]*\b(main|master)\b/, reason: 'Push su main/master non consentito: usa un branch ciccio/... e apri una PR.' },
  { test: /\bgit\s+push\b(?=[^|;&]*(--force\b|-f\b|--force-with-lease\b))(?![^|;&]*\bciccio\/)/, reason: 'Force push consentito solo sui branch ciccio/...' },
];

const ASK: { test: RegExp; reason: string }[] = [
  { test: /(^|[\s;&|(])sudo\s/, reason: 'comando con sudo' },
  { test: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME)/, reason: 'cancellazione ricorsiva fuori dal progetto' },
  { test: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, reason: 'script scaricato ed eseguito' },
  { test: /\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE?)\b/i, reason: 'operazione distruttiva sul database' },
  { test: /\b(ssh|scp|rsync)\b[^\n]*\b(rm\s+-[a-zA-Z]*[rR]|docker\s+(rm|rmi|system\s+prune|volume\s+rm)|systemctl\s+(stop|disable|mask)|reboot|shutdown|mkfs|dd\s+if=)/, reason: 'comando distruttivo su un server remoto' },
  { test: /\b(mkfs|shutdown|reboot)\b|\bdd\s+if=/, reason: 'comando di sistema distruttivo' },
];

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function hardDeny(toolName: string, input: Record<string, unknown>): Verdict | null {
  if (toolName !== 'Bash') return null;
  const cmd = typeof input.command === 'string' ? input.command : '';
  for (const r of DENY) if (r.test.test(cmd)) return { action: 'deny', reason: r.reason };
  return null;
}

function insideRepo(input: Record<string, unknown>, repoDir: string): boolean {
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '';
  if (!file) return true;
  const rel = path.relative(repoDir, path.resolve(repoDir, file));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Decisione per livello di autorizzazione, scelto dall'utente chat per chat.
 * In ogni livello restano bloccati il push su main e il force push fuori da ciccio/.
 */
export function decide(level: PermissionLevel, toolName: string, input: Record<string, unknown>, repoDir: string, hints?: ToolHints): Verdict {
  // Una domanda non è un'azione: va sempre all'utente, in ogni livello (la gestisce askQuestion).
  if (toolName === ASK_TOOL) return { action: 'ask', reason: `domanda per ${OWNER}` };
  const denied = hardDeny(toolName, input);
  if (denied) return denied;
  switch (level) {
    case 'bypass':
      return { action: 'allow' };
    case 'auto':
      return judge(toolName, input, repoDir, hints);
    case 'edits':
      if (WRITE_TOOLS.has(toolName) && insideRepo(input, repoDir)) return { action: 'allow' };
      return { action: 'ask', reason: 'livello Accetta modifiche: i comandi chiedono conferma' };
    case 'manual':
    default:
      return { action: 'ask', reason: 'livello Manuale' };
  }
}

export function judge(toolName: string, input: Record<string, unknown>, repoDir: string, hints?: ToolHints): Verdict {
  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    for (const r of DENY) if (r.test.test(cmd)) return { action: 'deny', reason: r.reason };
    for (const r of ASK) if (r.test.test(cmd)) return { action: 'ask', reason: r.reason };
    return { action: 'allow' };
  }
  if (WRITE_TOOLS.has(toolName)) {
    return insideRepo(input, repoDir) ? { action: 'allow' } : { action: 'ask', reason: 'modifica di un file fuori dal repo' };
  }
  // Connettori e server MCP: le letture passano, le azioni (inviare, creare, modificare…) chiedono.
  if (toolName.startsWith('mcp__')) {
    const [, server = '', rest = ''] = toolName.split('__');
    // Strumenti dei PC (mcp__pc_<pc>__<server>_<strumento>): conta il nome dello strumento, senza il server locale.
    const pc = server.startsWith('pc_');
    const action = pc ? rest.slice(rest.indexOf('_') + 1) : toolName.split('__').pop() ?? '';
    // Uno strumento che si dichiara un'azione (un comando consentito del PC, uno strumento su misura del progetto)
    // chiede, qualunque sia il nome (anche list_…).
    if (hints?.readOnly === false) return { action: 'ask', reason: pc ? `azione sul PC di ${OWNER}` : 'strumento su misura che modifica' };
    return hints?.readOnly || /^(get|list|search|read|fetch|query|find|view|show|describe|whoami|check|lookup|count)/i.test(action)
      ? { action: 'allow' }
      : { action: 'ask', reason: pc ? `azione sul PC di ${OWNER}` : 'azione di un connettore' };
  }
  return { action: 'allow' };
}
