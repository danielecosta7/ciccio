import fs from 'node:fs';
import { query, type SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv, config } from './config.js';
import { settings } from './settings.js';
import { store } from './db.js';
import { skillsDir } from './skills.js';
import { sessionLockdown } from './confine.js';
import { CICCIO_THREAD, type SlashCommandView } from '../../shared/types.js';

// Comandi con «/» di ogni chat, per l'elenco che compare scrivendo «/» nel campo: skill (utente, progetto,
// plugin) e comandi di Claude Code. Dipendono dal progetto (le skill del repo), non dalla singola chat,
// e per Ciccio dalle sue impostazioni. Si aggiornano a ogni giro dalla sessione stessa; se non ci sono
// ancora (progetto mai usato, server appena riavviato) si chiedono a un processo dell'SDK aperto apposta,
// che risponde in un secondo senza chiamare il modello.

/** Comandi di Claude Code che in Ciccio non servono o non funzionano: sono del terminale o li fa già l'interfaccia. */
const HIDDEN = new Set([
  'agents', 'auto-mode-setup', 'autocompact', 'clear', 'color', 'config', 'design-consent', 'design-revoke', 'doctor',
  'effort', 'extra-usage', 'fast', 'focus', 'heapdump', 'import', 'list-agents', 'mcp', 'model', 'output-style',
  'plugin-authoring', 'reload-plugins', 'rename', 'run-skill-generator', 'team-onboarding', 'usage-credits', 'workflow-launch-exec',
]);

const FRESH_MS = 10 * 60_000;
const cache = new Map<string, { at: number; list: SlashCommandView[] }>();
const probing = new Map<string, Promise<SlashCommandView[]>>();

function views(list: SlashCommand[]): SlashCommandView[] {
  const seen = new Set<string>();
  const out: SlashCommandView[] = [];
  for (const c of list) {
    if (!c.name || c.name.startsWith('_') || HIDDEN.has(c.name) || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ name: c.name, description: (c.description ?? '').replace(/\s+/g, ' ').trim(), ...(c.argumentHint ? { hint: c.argumentHint } : {}) });
  }
  return out;
}

/** Elenco aggiornato da una sessione in corso (supportedCommands() o il messaggio commands_changed). */
export function saveCommands(id: string, list: SlashCommand[]) {
  cache.set(id, { at: Date.now(), list: views(list) });
}

/** Ultima volta che si è installata o tolta una skill (la cartella cambia data): gli elenchi di prima sono vecchi. */
function skillsChanged(): number {
  try { return fs.statSync(skillsDir()).mtimeMs; } catch { return 0; }
}

/** Processo dell'SDK senza messaggi: l'elenco arriva dall'inizializzazione, poi si chiude. */
async function probe(cwd: string, opts: { settingSources: ('user' | 'project' | 'local')[]; tools?: string[] }): Promise<SlashCommand[]> {
  const abort = new AbortController();
  const idle = new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve()));
  async function* none() { await idle; }
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    const q = query({
      prompt: none(),
      // Con il blocco delle sessioni: all'avvio partirebbero hook e server MCP scritti nei file del repo, fuori da ogni sandbox.
      options: { cwd, abortController: abort, settingSources: opts.settingSources, ...(opts.tools ? { tools: opts.tools } : {}), settings: { disableAllHooks: true }, managedSettings: sessionLockdown(), env: claudeEnv },
    });
    return await q.supportedCommands();
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

async function cached(id: string, load: () => Promise<SlashCommand[]>): Promise<SlashCommandView[]> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < FRESH_MS && hit.at > skillsChanged()) return hit.list;
  let p = probing.get(id);
  if (!p) {
    p = load().then((list) => { saveCommands(id, list); return cache.get(id)!.list; }).finally(() => probing.delete(id));
    probing.set(id, p);
  }
  // Un elenco vecchio va benissimo mentre arriva quello nuovo.
  if (hit) { p.catch(() => undefined); return hit.list; }
  return p;
}

/** Comandi delle chat di un progetto (null se il progetto non c'è). */
export async function projectCommands(agentId: string): Promise<SlashCommandView[] | null> {
  const row = store.agent(agentId);
  if (!row) return null;
  return cached(agentId, () => probe(row.path, { settingSources: ['user', 'project', 'local'] }));
}

/** Ciccio ha due elenchi, con e senza skill: cambiando l'impostazione vale subito quello giusto. */
export const ciccioKey = () => `${CICCIO_THREAD}:${settings().ciccioSkills ? 'skill' : 'base'}`;

/** Comandi della chat con Ciccio: le skill solo se acceso nelle Impostazioni. */
export async function ciccioCommands(): Promise<SlashCommandView[]> {
  const skills = settings().ciccioSkills;
  return cached(ciccioKey(), () => probe(config.projectsDir, {
    settingSources: skills ? ['user'] : [],
    tools: skills ? ['Read', 'Glob', 'Grep', 'WebSearch', 'Skill'] : ['Read', 'Glob', 'Grep', 'WebSearch'],
  }));
}

/**
 * Un comando scritto a metà messaggio («sistema il titolo e poi /cpd»): Claude Code esegue i comandi solo se il
 * messaggio comincia con «/», e a metà testo l'agente lo leggeva come parole (una skill che parte solo se la chiami
 * tu non la può avviare da sé). Se nel testo c'è un comando conosciuto di quella chat, come parola a sé, lo si
 * porta in testa e il resto diventa il suo argomento: «/cpd sistema il titolo e poi». Solo il primo; il messaggio in
 * chat resta com'è. `key`: id del progetto, o ciccioKey().
 */
export function hoistCommand(key: string, text: string): string {
  if (text.startsWith('/')) return text;
  const names = new Set((cache.get(key)?.list ?? []).map((c) => c.name));
  if (!names.size) return text;
  for (const m of text.matchAll(/(^|\s)\/([\w:.-]+)(?=\s|$)/g)) {
    if (!names.has(m[2])) continue;
    const at = (m.index ?? 0) + m[1].length;
    const rest = `${text.slice(0, at)}${text.slice(at + m[2].length + 1)}`.replace(/[ \t]{2,}/g, ' ').trim();
    return `/${m[2]}${rest ? ` ${rest}` : ''}`;
  }
  return text;
}
