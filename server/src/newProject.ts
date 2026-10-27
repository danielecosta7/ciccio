import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, mainOrigin, OWNER } from './config.js';
import { syncProjects } from './projects.js';
import { createChat, sendToChat } from './agents.js';
import { gitAsync } from './git.js';
import { dayIn } from '../../shared/tz.js';

const run = promisify(execFile);

// Progetto nuovo da Ciccio: repo privato su GitHub (gh), clone in projectsDir, primo commit
// con README e STATUS.md, registrazione e prima chat. Il repo nasce con main già spinto,
// così gli agenti partono subito con i loro branch ciccio/… e le PR.

export const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{1,62}$/;

const STATUS = (today: string) => `# Stato del progetto

## Fatto
- Progetto creato da Ciccio

## Fermo su

## Serve da ${OWNER}

## Serve strumento locale

## Prossimo passo
- Definire cosa costruire

aggiornato: ${today}
`;

function author() {
  // Il primo commit lo firma Ciccio: sul server git non ha un'identità globale.
  const email = `ciccio@${new URL(mainOrigin).hostname}`;
  return { GIT_AUTHOR_NAME: 'Ciccio', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'Ciccio', GIT_COMMITTER_EMAIL: email };
}

/** Prima riga dell'errore di un comando (stderr se c'è). */
const errText = (e: unknown) => String((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n')[0];

/** Utente GitHub del server: senza gh o senza login, un errore che dice cosa fare. */
async function ghLogin(): Promise<string> {
  try {
    return (await run('gh', ['api', 'user', '--jq', '.login'], { timeout: 30_000 })).stdout.trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Sul server manca GitHub CLI (gh): installalo, poi `gh auth login` come l\'utente di Ciccio.');
    throw new Error(`GitHub CLI non è collegato sul server: esegui \`gh auth login\` come l'utente di Ciccio (${errText(e)}).`);
  }
}

/** Il repo esiste ed è vuoto (nessun commit). */
async function repoEmpty(repo: string): Promise<boolean> {
  try { return (await run('gh', ['repo', 'view', repo, '--json', 'isEmpty', '--jq', '.isEmpty'], { timeout: 30_000 })).stdout.trim() === 'true'; } catch { return false; }
}

export async function createProject(opts: { name: string; description?: string; message?: string }): Promise<{ agentId: string; chatId: string; url: string }> {
  const name = opts.name.trim().toLowerCase();
  if (!PROJECT_NAME.test(name)) throw new Error('Nome non valido: lettere minuscole, cifre, punto, trattino o trattino basso (es. sito-nuovo).');
  const dir = path.join(config.projectsDir, name);
  if (fs.existsSync(dir)) throw new Error(`Esiste già una cartella "${name}" tra i progetti.`);
  const description = (opts.description ?? '').trim().slice(0, 300);
  fs.mkdirSync(config.projectsDir, { recursive: true });
  const login = await ghLogin();

  try {
    await run('gh', ['repo', 'create', name, '--private', ...(description ? ['--description', description] : [])], { cwd: config.projectsDir, timeout: 60_000 });
  } catch (e) {
    const err = errText(e);
    // Un tentativo di prima si è fermato dopo aver creato il repo: se è ancora vuoto, si riusa.
    if (/already exists|Name already exists/i.test(err)) {
      if (!(await repoEmpty(`${login}/${name}`))) throw new Error(`Su GitHub esiste già un repo "${name}".`);
    } else if (/403|Resource not accessible|permission/i.test(err)) {
      throw new Error('Il token GitHub del server non può creare repository: in GitHub › Settings › Developer settings › il token di Ciccio, Repository permissions › Administration: Read and write.');
    } else throw new Error(`GitHub non ha creato il repo: ${err}`);
  }
  const url = `https://github.com/${login}/${name}.git`;

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n${description ? `\n${description}\n` : ''}`);
    fs.writeFileSync(path.join(dir, 'STATUS.md'), STATUS(dayIn()));
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n.env.*\n.DS_Store\ndist/\n.ciccio/\n');
    const git = (...args: string[]) => gitAsync(args, { cwd: dir, env: author(), timeout: 60_000 });
    await git('init', '-q', '-b', 'main');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'chore: avvio del progetto');
    await git('remote', 'add', 'origin', url);
    await git('push', '-q', '-u', 'origin', 'main');
  } catch (e) {
    // Niente cartella a metà: riprovando si riparte da capo e il repo vuoto su GitHub si riusa.
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Progetto non preparato sul server: ${errText(e)}. Riprova: il repo su GitHub c'è già e si riusa.`);
  }

  syncProjects();
  const chat = createChat(name, opts.message ? undefined : 'Avvio');
  if (opts.message?.trim()) sendToChat(chat.id, opts.message.trim(), 'user');
  return { agentId: name, chatId: chat.id, url: url.replace(/\.git$/, '') };
}

/** Repo GitHub dell'utente non ancora tra i progetti di Ciccio (per aggiungerne uno esistente). */
export async function githubRepos(): Promise<{ name: string; description: string; private: boolean; updatedAt: string; archived: boolean }[]> {
  const { stdout } = await run('gh', ['repo', 'list', '--limit', '300', '--json', 'name,description,isPrivate,updatedAt,isArchived'], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  const have = new Set(fs.existsSync(config.projectsDir) ? fs.readdirSync(config.projectsDir) : []);
  return (JSON.parse(stdout) as { name: string; description: string | null; isPrivate: boolean; updatedAt: string; isArchived: boolean }[])
    .filter((r) => !have.has(r.name))
    .map((r) => ({ name: r.name, description: r.description ?? '', private: r.isPrivate, updatedAt: r.updatedAt, archived: r.isArchived }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Un repo da aggiungere: il solo nome (un tuo repo), owner/nome (anche di un'organizzazione) o l'indirizzo GitHub. */
const REPO_REF = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)?(?:([A-Za-z0-9][A-Za-z0-9-]{0,38})\/)?([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;

/** Aggiunge un repo GitHub esistente: clone sul server, registrazione, prima chat. */
export async function importProject(ref: string, message?: string): Promise<{ agentId: string; chatId: string }> {
  const m = REPO_REF.exec(ref.trim().replace(/\/+$/, '').replace(/\.git$/, ''));
  if (!m) throw new Error('Repo non valido: scrivi il nome, owner/nome o l\'indirizzo GitHub.');
  const name = m[2];
  const dir = path.join(config.projectsDir, name);
  if (fs.existsSync(dir)) throw new Error(`"${name}" è già tra i progetti.`);
  fs.mkdirSync(config.projectsDir, { recursive: true });
  const owner = m[1] ?? await ghLogin();
  try {
    await gitAsync(['clone', '-q', `https://github.com/${owner}/${name}.git`, dir], { timeout: 10 * 60_000 });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Clone di ${owner}/${name} non riuscito: ${errText(e)}`);
  }
  syncProjects();
  const chat = createChat(name, message ? undefined : 'Prima chat');
  if (message?.trim()) sendToChat(chat.id, message.trim(), 'user');
  return { agentId: name, chatId: chat.id };
}
