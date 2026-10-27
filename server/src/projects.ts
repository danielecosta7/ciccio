import fs from 'node:fs';
import path from 'node:path';
import { config, OWNER } from './config.js';
import { store } from './db.js';
import { gitSync } from './git.js';

/** Registra ogni repo git in projectsDir come agente. */
export function syncProjects(): string[] {
  if (!fs.existsSync(config.projectsDir)) return [];
  const ids: string[] = [];
  for (const entry of fs.readdirSync(config.projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(config.projectsDir, entry.name);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    store.upsertAgent(entry.name, dir, lastCommitMs(dir));
    ids.push(entry.name);
  }
  return ids;
}

function lastCommitMs(dir: string): number | null {
  try {
    const out = gitSync(['-C', dir, 'log', '-1', '--format=%ct'], { timeout: 5000 }).trim();
    return out ? Number(out) * 1000 : null;
  } catch {
    return null;
  }
}

export interface StatusMd {
  raw: string;
  sections: Record<string, string[]>;
}

/** Legge STATUS.md e ne estrae le sezioni "## Titolo" con i loro punti elenco. */
export function readStatusMd(dir: string): StatusMd | null {
  const file = path.join(dir, 'STATUS.md');
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').slice(0, 8000);
  const sections: Record<string, string[]> = {};
  let current = '';
  for (const line of raw.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { current = h[1].toLowerCase(); sections[current] = []; continue; }
    const item = line.match(/^\s*[-*]\s+(?:\[[ x]\]\s+)?(.+)$/);
    if (item && current) sections[current].push(item[1].trim());
  }
  return { raw, sections };
}

/** Il primo punto aperto di STATUS.md, per la riga della card. */
/** Sezioni di STATUS.md con lavoro aperto, in ordine di urgenza (le chiavi sono in minuscolo). */
const OPEN_SECTIONS = [`serve da ${OWNER.toLowerCase()}`, 'fermo su', 'serve strumento locale', 'prossimo passo'];

export function statusHeadline(s: StatusMd): string | null {
  for (const key of OPEN_SECTIONS) {
    const items = s.sections[key];
    if (items?.length) return items[0];
  }
  return null;
}

export function hasOpenWork(s: StatusMd): boolean {
  return OPEN_SECTIONS.some((k) => (s.sections[k]?.length ?? 0) > 0);
}
