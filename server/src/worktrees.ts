import fs from 'node:fs';
import path from 'node:path';
import { store, type AgentRow, type ChatRow } from './db.js';
import { ignoreCiccioDir } from './files.js';
import { gitSync } from './git.js';

// Worktree delle chat: la prima chat di un progetto lavora nella cartella del repo; le altre ognuna nel suo
// worktree git (repo/.ciccio/worktrees/<chat>, branch ciccio/chat-<chat>), così due chat al lavoro sullo stesso
// progetto non cambiano branch e file l'una sotto i piedi dell'altra. .ciccio/ è già escluso da git.
// Nessun costo in token: cambia solo la cartella in cui gira la sessione.

const git = (repo: string, args: string[], timeout = 30_000) =>
  gitSync(['-C', repo, ...args], { timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Branch da cui parte il worktree: il principale del remoto aggiornato, se c'è; altrimenti quello di adesso. */
function baseOf(repo: string): string {
  try { git(repo, ['fetch', '--quiet', 'origin'], 60_000); } catch { /* senza rete si parte da quello che c'è */ }
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    try { git(repo, ['rev-parse', '--verify', '--quiet', ref]); return ref; } catch { /* il prossimo */ }
  }
  return 'HEAD';
}

/** Crea il worktree della chat; null se il progetto non è un repo git o git rifiuta (la chat usa la cartella del repo). */
export function createChatWorktree(repo: string, chatId: string): { dir: string; branch: string } | null {
  try {
    git(repo, ['rev-parse', '--git-dir']);
    ignoreCiccioDir(repo);
    const dir = path.join(repo, '.ciccio', 'worktrees', chatId);
    const branch = `ciccio/chat-${chatId}`;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(repo, ['worktree', 'add', '--quiet', '-b', branch, dir, baseOf(repo)], 120_000);
    ignoreCiccioDir(dir);
    return { dir, branch };
  } catch (err) {
    console.error(`Worktree per la chat ${chatId} non creato:`, (err as Error).message);
    return null;
  }
}

/** Cartella in cui lavora la chat: il suo worktree se esiste ancora, altrimenti quella del progetto. */
export function chatDir(chat: Pick<ChatRow, 'worktree'> | null | undefined, row: Pick<AgentRow, 'path'>): string {
  return chat?.worktree && fs.existsSync(chat.worktree) ? chat.worktree : row.path;
}

/** Per le rotte dei file: cartella del progetto o, con `chatId` di una chat del progetto, quella della chat. */
export function dirFor(agentId: string, chatId?: string | null): string | null {
  const row = store.agent(agentId);
  if (!row) return null;
  const chat = chatId ? store.chat(chatId) : null;
  return chat && chat.agent_id === agentId ? chatDir(chat, row) : row.path;
}

/**
 * Chat archiviata: il worktree si toglie solo se non ha modifiche da salvare (il branch resta, con i suoi commit
 * e l'eventuale PR). Con modifiche resta dov'è: restituisce false.
 */
export function removeChatWorktree(repo: string, dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) return true;
    if (git(dir, ['status', '--porcelain'])) return false;
    git(repo, ['worktree', 'remove', dir], 60_000);
    return true;
  } catch (err) {
    console.error(`Worktree ${dir} non rimosso:`, (err as Error).message);
    return false;
  }
}
