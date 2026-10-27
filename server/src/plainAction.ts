import path from 'node:path';

// Cosa vuole fare un agente, detto come lo direbbe una persona: per gli avvisi all'utente (chat di Ciccio e
// notifiche dei PC). Niente nomi tecnici degli strumenti, niente JSON.

const words = (s: string) => s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function plainAction(tool: string, input: Record<string, unknown>): string {
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (tool === 'Bash') return `eseguire il comando «${short(str(input.command).split('\n')[0].trim(), 60)}»`;
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return `modificare ${file ? path.basename(file) : 'un file'}`;
  if (tool === 'Read') return `leggere ${file ? path.basename(file) : 'un file'}`;
  if (tool === 'WebFetch') { try { return `aprire il sito ${new URL(str(input.url)).host}`; } catch { return 'aprire un sito'; } }
  if (tool === 'SSH') return 'usare le tue chiavi SSH';
  if (tool.endsWith('__usa_credenziale')) return 'usare un segreto di 1Password';
  if (tool.endsWith('__installa_programma')) return `installare ${str(input.pacchetto) || 'un programma'}`;
  if (tool.endsWith('__consenti_dominio')) return `raggiungere il sito ${str(input.dominio) || 'nuovo'}`;
  const pc = /^mcp__pc_([^_]+)__([^_]+)_(.+)$/.exec(tool);
  if (pc) { const app = words(pc[2]); return `usare ${app.charAt(0).toUpperCase()}${app.slice(1)} sul PC «${pc[1]}» (${short(words(pc[3]), 40)})`; }
  const conn = /^mcp__claude_ai_(.+?)__(.+)$/.exec(tool);
  if (conn) return `usare il connettore ${words(conn[1])} (${short(words(conn[2]).replace(/^ha /i, ''), 40)})`;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return `usare ${words(mcp[1])} (${short(words(mcp[2]), 40)})`;
  return `usare ${words(tool)}`;
}

/** Testo da notifica: niente markdown né caratteri di codice, al massimo `max` caratteri, tagliato a parola intera. */
export function plainText(s: string, max = 170): string {
  const t = s.replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>|]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).trimEnd()}…`;
}
