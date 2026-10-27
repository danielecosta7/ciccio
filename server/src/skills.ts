import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SkillView } from '../../shared/types.js';

const run = promisify(execFile);

// Skill di Claude Code per tutti gli agenti (e per Ciccio, se acceso): cartelle con SKILL.md
// in ~/.claude/skills dell'utente del server. Si installano da GitHub o da un file, si tolgono.
// Valgono dal messaggio successivo: le sessioni le leggono quando partono.

export const skillsDir = () => path.join(os.homedir(), '.claude', 'skills');
const SOURCE = '.ciccio-source';
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function frontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const get = (k: string) => m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '');
  return { name: get('name'), description: get('description') };
}

/** Skill del tuo account claude.ai: Claude Code le sincronizza in ~/.claude/skills/synced/<account>/<skill>. */
function syncedSkills(): SkillView[] {
  const root = path.join(skillsDir(), 'synced');
  if (!fs.existsSync(root)) return [];
  const out: SkillView[] = [];
  for (const acct of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'))) {
    const base = path.join(root, acct.name);
    for (const e of fs.readdirSync(base, { withFileTypes: true }).filter((x) => x.isDirectory() && fs.existsSync(path.join(base, x.name, 'SKILL.md')))) {
      const fm = frontmatter(fs.readFileSync(path.join(base, e.name, 'SKILL.md'), 'utf8').slice(0, 4000));
      out.push({ id: `synced/${e.name}`, name: fm.name || e.name, description: fm.description ?? '', source: 'account claude.ai', installedAt: fs.statSync(path.join(base, e.name)).mtimeMs, synced: true });
    }
  }
  return out;
}

/** Cartelle (o link a cartelle) con SKILL.md in ~/.claude/skills, per nome: le skill installate qui. */
function localDirs(): Map<string, string> {
  const dir = skillsDir();
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'synced' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    // Anche i link simbolici (skill aggiunte con altri strumenti): Claude Code li segue.
    const isDir = e.isDirectory() || (e.isSymbolicLink() && !!fs.statSync(full, { throwIfNoEntry: false })?.isDirectory());
    if (isDir && fs.existsSync(path.join(full, 'SKILL.md'))) out.set(e.name, full);
  }
  return out;
}

/** Le skill che vedono gli agenti: installate qui e sincronizzate dall'account. Fonte unica per l'elenco e per «già installata». */
export function listSkills(): SkillView[] {
  return [...[...localDirs()].map(([id, full]): SkillView => {
    const fm = frontmatter(fs.readFileSync(path.join(full, 'SKILL.md'), 'utf8').slice(0, 4000));
    const src = path.join(full, SOURCE);
    return {
      id,
      name: fm.name || id,
      description: fm.description ?? '',
      source: fs.existsSync(src) ? fs.readFileSync(src, 'utf8').trim() : null,
      installedAt: fs.statSync(full).mtimeMs,
    };
  }), ...syncedSkills()]
    .sort((a, b) => Number(!!a.synced) - Number(!!b.synced) || a.name.localeCompare(b.name));
}

/** La skill c'è già: la UI propone di aggiornarla. */
export class SkillExists extends Error {
  constructor(readonly id: string) { super(`La skill "${id}" è già installata.`); }
}

/** Cartelle con SKILL.md sotto `root` (al massimo 4 livelli). Delle cartelle nascoste guarda solo .claude. */
function findSkills(root: string, depth = 0): string[] {
  if (fs.existsSync(path.join(root, 'SKILL.md'))) return [root];
  if (depth >= 4) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (!e.name.startsWith('.') || e.name === '.claude') && e.name !== 'node_modules')
    .flatMap((e) => findSkills(path.join(root, e.name), depth + 1));
}

function skillId(d: string) {
  const fm = frontmatter(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'));
  return (fm.name && NAME.test(fm.name) ? fm.name : path.basename(d)).toLowerCase();
}

function copySkills(dirs: string[], source: string, replace: boolean): string[] {
  // Molti repo hanno la stessa skill in più cartelle, una per strumento (.claude/, plugin/, cursor-plugin/…):
  // se ne installa una per nome, quella per Claude Code se c'è, se no la meno annidata.
  const rank = (d: string) => (d.split(path.sep).includes('.claude') ? 0 : 100) + d.split(path.sep).length;
  const byId = new Map<string, string>();
  for (const d of [...dirs].sort((a, b) => rank(a) - rank(b))) {
    const id = skillId(d);
    if (NAME.test(id) && !byId.has(id)) byId.set(id, d);
  }
  if (!byId.size) throw new Error('Non ho trovato nessuna SKILL.md lì dentro.');
  if (byId.size > 50) throw new Error(`Ci sono ${byId.size} skill: indica una sottocartella più precisa.`);
  // Tutti i controlli prima di copiare: si installano tutte o nessuna.
  const have = new Map(listSkills().map((s) => [s.synced ? s.id.slice('synced/'.length) : s.id, s]));
  for (const id of byId.keys()) {
    const s = have.get(id);
    if (s?.synced) throw new Error(`La skill "${id}" c'è già dal tuo account claude.ai: si gestisce lì.`);
    if (s && !replace) throw new SkillExists(id);
  }
  fs.mkdirSync(skillsDir(), { recursive: true });
  for (const [id, d] of byId) {
    const dest = path.join(skillsDir(), id);
    // Al posto della versione vecchia, o di una cartella rimasta senza SKILL.md (che non è in elenco).
    fs.rmSync(dest, { recursive: true, force: true });
    // Copia senza seguire i link simbolici: niente file fuori dalla cartella della skill.
    fs.cpSync(d, dest, { recursive: true, dereference: false, filter: (src) => !fs.lstatSync(src).isSymbolicLink() });
    fs.writeFileSync(path.join(dest, SOURCE), `${source}\n`);
  }
  return [...byId.keys()];
}

/** https://github.com/owner/repo, …/tree/<ref>/<cartella> o …/blob/<ref>/<cartella>/SKILL.md */
export async function installFromGitHub(url: string, replace = false): Promise<string[]> {
  const m = url.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/);
  if (!m) throw new Error('Serve un indirizzo GitHub, es. https://github.com/anthropics/skills/tree/main/skills/pdf');
  const [, owner, repo, ref, sub] = m;
  // Nomi fatti solo di punti (o un ref con ? e #) cambierebbero la richiesta a gh api: repos/../… è un'altra API di GitHub.
  if ([owner, repo, ref ?? 'x'].some((s) => /^\.+$/.test(s) || /[?#]/.test(s))) throw new Error('Indirizzo GitHub non valido.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-skill-'));
  try {
    const tarball = path.join(tmp, 'repo.tgz');
    // gh passa dal proxy in uscita e vede anche i repo privati dell'utente.
    const { stdout } = await run('gh', ['api', `repos/${owner}/${repo}/tarball${ref ? `/${ref}` : ''}`], { encoding: 'buffer', maxBuffer: 200 * 1024 * 1024, timeout: 120_000 });
    fs.writeFileSync(tarball, stdout);
    const out = path.join(tmp, 'x');
    fs.mkdirSync(out);
    await run('tar', ['-xzf', tarball, '-C', out, '--no-same-owner'], { timeout: 120_000 });
    const top = fs.readdirSync(out)[0];
    let base = path.join(out, top, ...(sub ? sub.replace(/\/?SKILL\.md$/i, '').split('/') : []));
    base = path.resolve(base);
    if (!base.startsWith(path.join(out, top)) || !fs.existsSync(base)) throw new Error('Cartella non trovata nel repo.');
    return copySkills(findSkills(base), url.trim(), replace);
  } catch (e) {
    if (e instanceof SkillExists) throw e;
    const err = String((e as { stderr?: Buffer | string }).stderr ?? '') || (e as Error).message;
    throw new Error(/Not Found|404/.test(err) ? 'Repo o cartella non trovati su GitHub.' : err.split('\n')[0]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Un .zip con una o più skill, oppure un solo SKILL.md. */
export async function installFromFile(name: string, data: Buffer, replace = false): Promise<string[]> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-skill-'));
  try {
    if (/\.md$/i.test(name)) {
      const fm = frontmatter(data.toString('utf8'));
      const id = (fm.name ?? '').toLowerCase();
      if (!NAME.test(id)) throw new Error('Nel SKILL.md manca "name:" nell\'intestazione (tra i ---).');
      const d = path.join(tmp, id);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'SKILL.md'), data);
      return copySkills([d], `file ${name}`, replace);
    }
    if (!/\.zip$/i.test(name)) throw new Error('Carica un .zip o un SKILL.md.');
    const zip = path.join(tmp, 'skill.zip');
    fs.writeFileSync(zip, data);
    const out = path.join(tmp, 'x');
    await run('python3', ['-I', '-m', 'zipfile', '-e', zip, out], { timeout: 120_000 });
    return copySkills(findSkills(out), `file ${name}`, replace);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function removeSkill(id: string) {
  if (!NAME.test(id)) throw new Error('Nome non valido');
  fs.rmSync(path.join(skillsDir(), id), { recursive: true, force: true });
}
