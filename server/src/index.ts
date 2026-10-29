import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { store } from './db.js';
import { bus } from './bus.js';
import { syncProjects, readStatusMd } from './projects.js';
import { setHidden, connectorsSeen, allAgents, agentView, chatView, createChat, sendToChat, compactChat, newSession, decideApproval, answerQuestion, stopChat, clearError, renameAgent, renameChat, archiveChat, setPermission, setModel, allowRules, removeRule, setConnectors, setPcTools, mcpStatus, suggestionOf } from './agents.js';
import { branch, checkFileToken, checkViewToken, diff, fileToken, mcpServers, mimeFor, safeFileName, safePath, sendFile, tree, uploadsDir, viewMimeFor, viewInScope, viewScope, viewToken, viewablePath } from './files.js';
import { recap, latestRecap, recapError, startDailyRecap, startNotices, talkToCiccio, stopCiccio, resetCiccio, ciccioRunning, ciccioContext, ciccioTurn, compactCiccio } from './ciccio.js';
import { authInfo, logAuth, refreshUsageIfStale, usageState } from './usage.js';
import { checkVoice, startVoiceHealth } from './voiceHealth.js';
import { serverStats, startServerStats } from './serverStats.js';
import { consumiReport, startConsumi } from './consumi.js';
import { baseCount, cleanDomain, egressHelper, extraDomains } from './egress.js';
import { dropSocket, setViewing } from './presence.js';
import { registerAuth } from './auth.js';
import { registerVoice } from './voice.js';
import { dirFor } from './worktrees.js';
import { createProject, githubRepos, importProject } from './newProject.js';
import { gitSync } from './git.js';
import { SkillExists, installFromFile, installFromGitHub, listSkills, removeSkill } from './skills.js';
import { publicOrigin, settings, updateSettings } from './settings.js';
import { ciccioCommands, projectCommands } from './commands.js';
import { registerCompanion } from './companion.js';
import { registerDesktop } from './desktop.js';
import { registerSetup } from './setup.js';
import { projectToolViews, removeProjectTool } from './projectTools.js';
import { createRoutine, fireRoutine, removeRoutine, routineRuns, routineViews, startRoutines, updateRoutine } from './routines.js';
import { activityNow, resumeAfterRestart, shutdown } from './restart.js';
import { CICCIO_THREAD, EFFORTS, MODELS, PERMISSION_LEVELS, type AgentInfo, type Attachment, type Effort, type PermissionLevel } from '../../shared/types.js';

// I token dei file per il visore di Office contengono il percorso: parametri più lunghi dei 100 caratteri di Fastify.
// req.ip (limite ai tentativi di accesso) legge X-Forwarded-For solo dai proxy fidati (config.trustProxy).
const app = Fastify({ logger: { level: 'info' }, routerOptions: { maxParamLength: 2000 }, trustProxy: config.trustProxy });
await app.register(websocket);
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 20 } });
// Prima di tutte le rotte: chi arriva da internet passa dal login con passkey.
registerAuth(app);
registerVoice(app);
registerCompanion(app);
registerDesktop(app);
registerSetup(app);

// La cartella dei progetti serve da subito: Ciccio ci lavora dentro e gh ci crea i repo nuovi.
fs.mkdirSync(config.projectsDir, { recursive: true });
logAuth();
console.log(`Fuso orario: ${config.tz}${process.env.CICCIO_TZ ? '' : ' (del sistema; si cambia con CICCIO_TZ)'}.`);
// Commit di Ciccio in esecuzione, letto una volta all'avvio: dopo un git pull senza riavvio resta quello che gira.
// Senza repo (o senza git) non c'è, e la pagina mostra solo il link al codice sorgente.
const COMMIT = (() => {
  try { return gitSync(['-C', import.meta.dirname, 'rev-parse', '--short', 'HEAD'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
})();
await startVoiceHealth(() => bus.emit({ type: 'settings', settings: settings() }));

syncProjects();
setInterval(syncProjects, 5 * 60_000).unref();
startDailyRecap();
startNotices();
startServerStats();
startConsumi();
startRoutines();

app.get('/api/agents', async () => allAgents());

// Chi lavora e chi aspetta l'utente: deploy/install.sh riavvia quando nessuno lavora (chi aspetta riprende dopo).
app.get('/api/activity', async () => activityNow());

app.post('/api/agents/sync', async () => ({ ids: syncProjects() }));

// Progetto nuovo: repo privato su GitHub, clone sul server, prima chat.
app.post<{ Body: { name?: string; description?: string; message?: string } }>('/api/projects', async (req, reply) => {
  try {
    return await createProject({ name: req.body?.name ?? '', description: req.body?.description, message: req.body?.message });
  } catch (e) {
    return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Chat ────────────────────────────────────────────────────────────────
// Ogni progetto ha più chat, come le sessioni di Claude Code; Ciccio ha la sua (CICCIO_THREAD).

app.post<{ Params: { id: string }; Body: { title?: string } }>('/api/agents/:id/chats', async (req, reply) => {
  if (!store.agent(req.params.id)) return reply.code(404).send({ error: 'agente sconosciuto' });
  return chatView(createChat(req.params.id, req.body?.title).id);
});

app.get<{ Params: { chatId: string } }>('/api/chats/:chatId/messages', async (req, reply) => {
  if (req.params.chatId !== CICCIO_THREAD && !store.chat(req.params.chatId)) return reply.code(404).send({ error: 'chat sconosciuta' });
  return { messages: store.messages(req.params.chatId), approvals: store.pendingApprovals(req.params.chatId) };
});

app.post<{ Params: { chatId: string }; Body: { text?: string; attachments?: Attachment[] } }>('/api/chats/:chatId/messages', async (req, reply) => {
  const chat = store.chat(req.params.chatId);
  const row = chat ? store.agent(chat.agent_id) : undefined;
  if (!chat || !row) return reply.code(404).send({ error: 'chat sconosciuta' });
  // Solo allegati caricati davvero nella cartella degli allegati del repo.
  const attachments = (req.body?.attachments ?? []).filter((a) => a && typeof a.path === 'string' && a.path.startsWith('.ciccio/uploads/') && safePath(row.path, a.path));
  const text = req.body?.text?.trim() || (attachments.length ? 'Guarda gli allegati.' : '');
  if (!text) return reply.code(400).send({ error: 'testo mancante' });
  return { result: sendToChat(chat.id, text, 'user', attachments) };
});

app.post<{ Params: { chatId: string }; Body: { title?: string } }>('/api/chats/:chatId/name', async (req, reply) => {
  if (!store.chat(req.params.chatId)) return reply.code(404).send({ error: 'chat sconosciuta' });
  renameChat(req.params.chatId, req.body?.title ?? '');
  return chatView(req.params.chatId);
});

app.post<{ Params: { chatId: string } }>('/api/chats/:chatId/archive', async (req, reply) => {
  if (!store.chat(req.params.chatId)) return reply.code(404).send({ error: 'chat sconosciuta' });
  archiveChat(req.params.chatId);
  return { ok: true };
});

app.post<{ Params: { chatId: string }; Body: { model?: string; effort?: string } }>('/api/chats/:chatId/settings', async (req, reply) => {
  if (!store.chat(req.params.chatId)) return reply.code(404).send({ error: 'chat sconosciuta' });
  const model = MODELS.find((m) => m.id === req.body?.model)?.id ?? null;
  const effort = (EFFORTS as string[]).includes(req.body?.effort ?? '') ? (req.body!.effort as Effort) : null;
  setModel(req.params.chatId, model, effort);
  return { ok: true };
});

app.post<{ Params: { chatId: string }; Body: { level?: string } }>('/api/chats/:chatId/permission', async (req, reply) => {
  if (!store.chat(req.params.chatId)) return reply.code(404).send({ error: 'chat sconosciuta' });
  const level = PERMISSION_LEVELS.find((l) => l.key === req.body?.level)?.key;
  if (!level) return reply.code(400).send({ error: 'livello non valido' });
  setPermission(req.params.chatId, level);
  return chatView(req.params.chatId);
});

app.post<{ Params: { chatId: string } }>('/api/chats/:chatId/stop', async (req) => ({ ok: stopChat(req.params.chatId) }));
app.post<{ Params: { chatId: string } }>('/api/chats/:chatId/clear-error', async (req) => { clearError(req.params.chatId); return { ok: true }; });

// ── Progetto ────────────────────────────────────────────────────────────

app.post<{ Params: { id: string } }>('/api/agents/:id/upload', async (req, reply) => {
  const row = store.agent(req.params.id);
  if (!row) return reply.code(404).send({ error: 'agente sconosciuto' });
  const dir = uploadsDir(row.path);
  const attachments: Attachment[] = [];
  for await (const part of req.files()) {
    const name = `${Date.now()}-${safeFileName(part.filename)}`;
    const dest = path.join(dir, name);
    await pipeline(part.file, fs.createWriteStream(dest));
    if (part.file.truncated) { fs.rmSync(dest, { force: true }); return reply.code(413).send({ error: `${part.filename}: file oltre 200 MB` }); }
    attachments.push({ name: part.filename, path: `.ciccio/uploads/${name}`, size: fs.statSync(dest).size });
  }
  return { attachments };
});

// ?chat=: per una chat con il suo worktree, file, modifiche, branch e STATUS.md sono quelli della sua cartella.
app.get<{ Params: { id: string }; Querystring: { chat?: string } }>('/api/agents/:id/info', async (req, reply) => {
  const row = store.agent(req.params.id);
  const dir = dirFor(req.params.id, req.query.chat);
  if (!row || !dir) return reply.code(404).send({ error: 'agente sconosciuto' });
  const info: AgentInfo = {
    branch: branch(dir), dir, worktree: dir !== row.path, claudeMd: fs.existsSync(path.join(dir, 'CLAUDE.md')),
    autoCompactWindow: settings().autoCompactWindow, statusMd: readStatusMd(dir)?.raw ?? null,
    allowRules: allowRules(row.id), mcpServers: mcpServers(row.path),
    connectors: !!row.connectors, mcpStatus: mcpStatus(row.id), pcTools: !!row.pc_tools, tools: projectToolViews(row.id),
  };
  return info;
});

// Comandi con «/» (skill e comandi di Claude Code) per l'elenco nel campo di testo.
app.get<{ Params: { id: string } }>('/api/agents/:id/commands', async (req, reply) => {
  try {
    const commands = await projectCommands(req.params.id);
    return commands ? { commands } : reply.code(404).send({ error: 'agente sconosciuto' });
  } catch (e) { return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) }); }
});
app.get<{ Params: { id: string }; Querystring: { chat?: string } }>('/api/agents/:id/tree', async (req, reply) => {
  const dir = dirFor(req.params.id, req.query.chat);
  if (!dir) return reply.code(404).send({ error: 'agente sconosciuto' });
  return { files: tree(dir) };
});

app.get<{ Params: { id: string }; Querystring: { path?: string; download?: string; chat?: string } }>('/api/agents/:id/file', async (req, reply) => {
  // Gli allegati si caricano nel repo del progetto (uploadsDir), non nel worktree della chat: lì si cercano sempre.
  const upload = req.query.path?.startsWith('.ciccio/uploads/');
  const dir = upload ? store.agent(req.params.id)?.path ?? null : dirFor(req.params.id, req.query.chat);
  if (!dir) return reply.code(404).send({ error: 'agente sconosciuto' });
  const abs = req.query.path ? viewablePath(dir, req.query.path) : null;
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return reply.code(404).send({ error: 'file non trovato' });
  // I file del repo non devono poter eseguire script nell'origine di Ciccio (SVG, HTML, XML, testo).
  // PDF, immagini raster e media restano senza sandbox, che bloccherebbe il visore PDF del browser.
  const mime = mimeFor(abs);
  if (/svg|html|xml|^text\//.test(mime) || mime === 'application/octet-stream') {
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  }
  reply.header('X-Content-Type-Options', 'nosniff');
  if (req.query.download) reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(abs))}"`);
  return sendFile(req, reply, abs, mime);
});

// Server raggiungibili in SSH dagli agenti: li decide il firewall (helper root ciccio-ssh-allow, da Impostazioni › Configurazione).
app.get('/api/ssh-hosts', async () => {
  try {
    return { hosts: fs.readFileSync('/etc/ciccio/ssh-hosts', 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean) };
  } catch { return { hosts: [] }; }
});

// Anteprima viva di una pagina HTML: l'indirizzo firmato vale un'ora e solo per la cartella della pagina, dentro la
// cartella della chat. Le pagine fuori dal progetto (home, /tmp) si vedono solo come codice.
app.get<{ Params: { id: string }; Querystring: { chat?: string; path?: string } }>('/api/agents/:id/view-token', async (req, reply) => {
  const dir = dirFor(req.params.id, req.query.chat);
  if (!dir) return reply.code(404).send({ error: 'agente sconosciuto' });
  const abs = req.query.path ? viewablePath(dir, req.query.path) : null;
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return reply.code(404).send({ error: 'File non trovato: forse è stato spostato o cancellato.' });
  const scope = viewScope(dir, abs);
  if (scope == null) return reply.code(400).send({ error: 'Le pagine fuori dal progetto non si aprono vive: guardane il codice, o chiedi all’agente di copiarla nel progetto.' });
  // Con la chat nell'indirizzo («progetto~chat») i file relativi della pagina si cercano nella cartella della chat.
  const who = req.query.chat ? `${req.params.id}~${req.query.chat}` : req.params.id;
  return { url: `/view/${encodeURIComponent(who)}/${viewToken(who, scope)}/${encodeURIComponent(path.basename(abs))}` };
});

// Pagine HTML e i loro file, per l'anteprima: fuori da /api perché le autorizza il token nell'indirizzo, non il cookie.
// La sandbox senza allow-same-origin le tiene lontane dai dati e dalle API di Ciccio; la CSP non le lascia parlare con
// altri server (fetch, WebSocket, moduli): librerie, font e immagini da https sì, come nelle pagine vere.
app.get<{ Params: { id: string; token: string; '*': string } }>('/view/:id/:token/*', async (req, reply) => {
  const [agentId, chatId] = req.params.id.split('~');
  const dir = store.agent(agentId) ? dirFor(agentId, chatId) : null;
  const scope = dir ? checkViewToken(req.params.id, req.params.token) : null;
  if (!dir || scope == null) return reply.code(403).type('text/plain').send('Anteprima scaduta: riaprila da Ciccio.');
  // Il router ha già decodificato i %xx: decodificare ancora aprirebbe «a%41.txt» come «aA.txt».
  const abs = viewInScope(dir, scope, req.params['*'] ?? '');
  if (!abs || !fs.statSync(abs).isFile()) return reply.code(404).type('text/plain').send('File non trovato.');
  reply.header('Content-Security-Policy', "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads; default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; form-action 'self'; base-uri 'self'");
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Cache-Control', 'no-store');
  return sendFile(req, reply, abs, viewMimeFor(abs));
});

// Limiti del visore di Office online: oltre, l'anteprima resta quella del browser.
const OFFICE_MAX: [RegExp, number][] = [[/\.(xlsx?|xlsm|ods)$/i, 5_000_000], [/\.(docx?|pptx?|odt|odp)$/i, 10_000_000]];

// Visore di Office online di Microsoft: solo se acceso in Impostazioni (di base no) e con un indirizzo pubblico, perché
// il file lo scaricano i server di Microsoft. Spento, { off: true }: la pagina mostra Excel e Word con i suoi lettori.
app.get<{ Params: { id: string }; Querystring: { path?: string; chat?: string } }>('/api/agents/:id/office', async (req, reply) => {
  const row = store.agent(req.params.id);
  const dir = dirFor(req.params.id, req.query.chat);
  if (!row || !dir) return reply.code(404).send({ error: 'agente sconosciuto' });
  if (!settings().officeOnline || !publicOrigin) return { off: true };
  const rel = req.query.path ?? '';
  const abs = rel ? viewablePath(dir, rel) : null;
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return reply.code(404).send({ error: 'file non trovato' });
  const max = OFFICE_MAX.find(([re]) => re.test(abs))?.[1];
  if (!max) return reply.code(400).send({ error: 'non è un documento di Office' });
  if (fs.statSync(abs).size > max) return reply.code(413).send({ error: `Il visore di Office apre file fino a ${max / 1_000_000} MB.` });
  // Nel token il percorso reale e assoluto del file: il link lo apre così com'è, anche da un worktree.
  const src = `${publicOrigin}/office/${encodeURIComponent(row.id)}/${fileToken(row.id, abs)}/${encodeURIComponent(path.basename(abs))}`;
  return {
    embed: `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(src)}`,
    page: `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(src)}`,
  };
});

// Il file per il visore di Office: lo chiedono i server di Microsoft, senza cookie, con il token di quel solo file.
app.get<{ Params: { id: string; token: string; name: string } }>('/office/:id/:token/:name', async (req, reply) => {
  const row = store.agent(req.params.id);
  const abs = row && settings().officeOnline ? checkFileToken(row.id, req.params.token) : null;
  if (!abs || !fs.statSync(abs).isFile()) return reply.code(404).type('text/plain').send('File non trovato o link scaduto.');
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  return sendFile(req, reply, abs, mimeFor(abs));
});

app.get<{ Params: { id: string }; Querystring: { chat?: string } }>('/api/agents/:id/diff', async (req, reply) => {
  const dir = dirFor(req.params.id, req.query.chat);
  if (!dir) return reply.code(404).send({ error: 'agente sconosciuto' });
  return diff(dir);
});

app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>('/api/agents/:id/connectors', async (req, reply) => {
  if (!agentView(req.params.id)) return reply.code(404).send({ error: 'agente sconosciuto' });
  setConnectors(req.params.id, req.body?.enabled === true);
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: { hidden?: boolean } }>('/api/agents/:id/hidden', async (req, reply) => {
  if (!store.agent(req.params.id)) return reply.code(404).send({ error: 'agente sconosciuto' });
  setHidden(req.params.id, req.body?.hidden === true);
  return agentView(req.params.id);
});

app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>('/api/agents/:id/pc-tools', async (req, reply) => {
  if (!agentView(req.params.id)) return reply.code(404).send({ error: 'agente sconosciuto' });
  setPcTools(req.params.id, req.body?.enabled === true);
  return { ok: true };
});

app.post<{ Params: { id: string }; Body: { rule?: string } }>('/api/agents/:id/rules/remove', async (req, reply) => {
  if (!agentView(req.params.id)) return reply.code(404).send({ error: 'agente sconosciuto' });
  if (req.body?.rule) removeRule(req.params.id, req.body.rule);
  return { rules: allowRules(req.params.id) };
});

// Strumenti su misura del progetto (proposti dagli agenti, approvati dall'utente): si tolgono da qui.
app.post<{ Params: { id: string }; Body: { name?: string } }>('/api/agents/:id/tools/remove', async (req, reply) => {
  if (!store.agent(req.params.id)) return reply.code(404).send({ error: 'agente sconosciuto' });
  if (!req.body?.name || !removeProjectTool(req.params.id, req.body.name)) return reply.code(404).send({ error: 'strumento sconosciuto' });
  return { tools: projectToolViews(req.params.id) };
});

app.post<{ Params: { id: string }; Body: { name?: string } }>('/api/agents/:id/name', async (req, reply) => {
  if (!agentView(req.params.id)) return reply.code(404).send({ error: 'agente sconosciuto' });
  renameAgent(req.params.id, req.body?.name ?? '');
  return agentView(req.params.id);
});

// Tutti i permessi in attesa: la dashboard li mostra sulle card dei progetti.
app.get('/api/approvals', async () => store.pendingApprovals());

app.post<{ Params: { id: string }; Body: { allow?: boolean; always?: boolean } }>('/api/approvals/:id', async (req, reply) => {
  const ok = decideApproval(req.params.id, req.body?.allow === true, req.body?.always === true);
  return ok ? { ok } : reply.code(404).send({ error: 'permesso non più in attesa' });
});

// Risposte a una domanda a scelte: { testo della domanda: risposta }; vuoto = domande saltate.
app.post<{ Params: { id: string }; Body: { answers?: Record<string, unknown> } }>('/api/approvals/:id/answer', async (req, reply) => {
  const raw = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
  const answers = Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
  return answerQuestion(req.params.id, answers) ? { ok: true } : reply.code(404).send({ error: 'domanda non più in attesa' });
});

// Uso di Claude: risponde subito con l'ultimo dato dell'abbonamento e, se è vecchio, lo aggiorna in background.
app.get('/api/usage', async () => {
  void refreshUsageIfStale();
  return usageState();
});

// Il riepilogo lo prepara il server ogni mattina (recapHour); qui si legge l'ultimo pronto e, se oggi non è
// riuscito, perché.
app.get('/api/recap', async () => ({ recap: latestRecap(), error: recapError() }));
app.post('/api/recap/refresh', async (_req, reply) => {
  try { return { recap: await recap(true) }; } catch (e) { return reply.code(502).send({ error: recapError() ?? (e instanceof Error ? e.message : String(e)) }); }
});

app.get<{ Params: { id: string }; Querystring: { chat?: string } }>('/api/agents/:id/status', async (req, reply) => {
  const dir = dirFor(req.params.id, req.query.chat);
  if (!dir) return reply.code(404).send({ error: 'agente sconosciuto' });
  return { statusMd: readStatusMd(dir)?.raw ?? null };
});

app.post<{ Body: { text?: string; voice?: boolean } }>('/api/ciccio', async (req, reply) => {
  const text = req.body?.text?.trim();
  if (!text) return reply.code(400).send({ error: 'testo mancante' });
  return { result: talkToCiccio(text, req.body?.voice === true) };
});
app.get('/api/ciccio/commands', async () => ({ commands: await ciccioCommands() }));
app.get('/api/ciccio/state', async () => ({ running: ciccioRunning(), activity: ciccioTurn().turn?.activity ?? 'idle', context: ciccioContext(), suggestion: suggestionOf(CICCIO_THREAD) }));
app.post('/api/ciccio/compact', async () => ({ result: compactCiccio() }));
app.post<{ Params: { chatId: string } }>('/api/chats/:chatId/compact', async (req, reply) => {
  if (!store.chat(req.params.chatId)) return reply.code(404).send({ error: 'chat sconosciuta' });
  return { result: compactChat(req.params.chatId) };
});
app.post<{ Params: { chatId: string } }>('/api/chats/:chatId/new-session', async (req, reply) => {
  if (!store.chat(req.params.chatId)) return reply.code(404).send({ error: 'chat sconosciuta' });
  newSession(req.params.chatId);
  return { ok: true };
});
app.post('/api/ciccio/stop', async () => ({ ok: stopCiccio() }));
app.post('/api/ciccio/reset', async () => { resetCiccio(); return { ok: true }; });

// Repo GitHub esistenti da aggiungere, e aggiunta.
app.get('/api/github/repos', async (_req, reply) => {
  try { return await githubRepos(); } catch (e) { return reply.code(502).send({ error: `GitHub non risponde: ${e instanceof Error ? e.message : String(e)}` }); }
});
app.post<{ Body: { name?: string; message?: string } }>('/api/projects/import', async (req, reply) => {
  try { return await importProject(req.body?.name ?? '', req.body?.message); }
  catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) }); }
});

// Connettori di claude.ai come li vedono le sessioni (per la procedura guidata).
app.get('/api/connectors', async () => connectorsSeen());

// Stato del server per la pagina Impostazioni.
app.get('/api/server', async () => {
  const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return ''; } };
  const df = sh('df', ['-k', config.projectsDir]).split('\n')[1]?.split(/\s+/) ?? [];
  const voice = await checkVoice();
  return {
    commit: COMMIT,
    // AGPL-3.0, sezione 13: dove prendere il codice di questo Ciccio.
    source: config.sourceUrl,
    node: process.version,
    uptime: Math.round(process.uptime()),
    voice,
    // Come si collegano le sessioni a Claude: dall'ultima sessione vista, o stimato dall'ambiente.
    auth: authInfo(),
    timeZone: config.tz,
    diskFreeGb: df[3] ? Math.round(Number(df[3]) / 1048576) : null,
    diskTotalGb: df[1] ? Math.round(Number(df[1]) / 1048576) : null,
    projects: store.agents().length,
  };
});

// Prestazioni del VPS (CPU, memoria, disco, rete, servizio Ciccio): campioni dell'ultima ora e del giorno.
app.get('/api/server/stats', async () => serverStats());
app.get('/api/consumi', async () => consumiReport());

// Domini del proxy in uscita aperti su richiesta degli agenti (egress.ts): elenco e rimozione.
app.get('/api/egress', async () => ({ base: baseCount(), extra: extraDomains() }));
app.post<{ Body: { dominio?: string } }>('/api/egress/remove', async (req, reply) => {
  const c = cleanDomain(req.body?.dominio ?? '', false);
  if ('error' in c) return reply.code(400).send({ error: c.error });
  const r = await egressHelper(['remove', c.domain]);
  if (!r.ok) return reply.code(400).send({ error: r.message });
  return { base: baseCount(), extra: extraDomains() };
});

// Skill di Claude Code per tutti gli agenti: elenco, installazione da GitHub o da file, rimozione.
app.get('/api/skills', async () => listSkills());
app.post<{ Body: { url?: string; replace?: boolean } }>('/api/skills/github', async (req, reply) => {
  try { return { installed: await installFromGitHub(req.body?.url ?? '', !!req.body?.replace), skills: listSkills() }; }
  catch (e) { return reply.code(e instanceof SkillExists ? 409 : 400).send({ error: e instanceof Error ? e.message : String(e), exists: e instanceof SkillExists ? e.id : undefined }); }
});
app.post<{ Querystring: { replace?: string } }>('/api/skills/upload', async (req, reply) => {
  try {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'Nessun file' });
    const data = await part.toBuffer();
    return { installed: await installFromFile(part.filename, data, req.query.replace === '1'), skills: listSkills() };
  } catch (e) { return reply.code(e instanceof SkillExists ? 409 : 400).send({ error: e instanceof Error ? e.message : String(e), exists: e instanceof SkillExists ? e.id : undefined }); }
});
app.post<{ Params: { id: string } }>('/api/skills/:id/remove', async (req, reply) => {
  try { removeSkill(req.params.id); return { skills: listSkills() }; }
  catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) }); }
});

// ── Routine ─────────────────────────────────────────────────────────────
// Messaggi che il server manda da solo a un progetto a orari fissi (routines.ts).

type RoutineBody = { agentId?: string; name?: string; text?: string; cron?: string; chatId?: string | null; enabled?: boolean; permission?: PermissionLevel | null };
const fail = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });

app.get<{ Querystring: { agentId?: string } }>('/api/routines', async (req) => routineViews(req.query.agentId || undefined));
app.get<{ Params: { id: string } }>('/api/routines/:id/runs', async (req) => ({ runs: routineRuns(req.params.id) }));
app.post<{ Body: RoutineBody }>('/api/routines', async (req, reply) => {
  const b = req.body ?? {};
  try { return createRoutine({ agentId: b.agentId ?? '', name: b.name ?? '', text: b.text ?? '', cron: b.cron ?? '', chatId: b.chatId ?? null, permission: b.permission ?? null }, 'utente'); }
  catch (e) { return reply.code(400).send(fail(e)); }
});
app.post<{ Params: { id: string }; Body: RoutineBody }>('/api/routines/:id', async (req, reply) => {
  const b = req.body ?? {};
  try { return updateRoutine(req.params.id, { name: b.name, text: b.text, cron: b.cron, chatId: b.chatId, enabled: b.enabled, permission: b.permission }); }
  catch (e) { return reply.code(400).send(fail(e)); }
});
app.post<{ Params: { id: string } }>('/api/routines/:id/run', async (req, reply) => {
  try { return { result: fireRoutine(req.params.id, true) }; } catch (e) { return reply.code(400).send(fail(e)); }
});
app.post<{ Params: { id: string } }>('/api/routines/:id/remove', async (req, reply) => (removeRoutine(req.params.id) ? { ok: true } : reply.code(404).send({ error: 'routine sconosciuta' })));

// Impostazioni dell'app (le può cambiare anche Ciccio).
app.get('/api/settings', async () => settings());
app.post<{ Body: Record<string, unknown> }>('/api/settings', async (req) => updateSettings(req.body ?? {}));

// Programmi da scaricare (companion e app desktop per Mac e Windows): file in <dataDir>/downloads, solo con accesso.
// Accanto ci sono i manifest e le firme Ed25519 (.sig) della release, per chi vuole controllarli a mano
// (docs/tecnico.md, «Firma delle release»).
const DOWNLOAD = /^[\w.-]+\.(dmg|exe|zip)$/;
const SERVED = /^([\w.-]+\.(dmg|exe|zip)|companion\.json|app\.json)(\.sig)?$/;

// Quali ci sono: la pagina mostra il pulsante solo per quelli, altrimenti spiega come averli.
app.get('/api/downloads', async () => {
  try { return { files: fs.readdirSync(path.join(config.dataDir, 'downloads')).filter((f) => DOWNLOAD.test(f)) }; } catch { return { files: [] }; }
});

app.get<{ Params: { file: string } }>('/download/:file', async (req, reply) => {
  const name = req.params.file;
  if (!SERVED.test(name)) return reply.code(404).send({ error: 'non trovato' });
  const abs = path.join(config.dataDir, 'downloads', name);
  if (!fs.existsSync(abs)) return reply.code(404).send({ error: 'Pacchetto non ancora pubblicato sul server.' });
  reply.header('Content-Disposition', `attachment; filename="${name}"`);
  reply.header('Content-Length', fs.statSync(abs).size);
  return reply.type('application/octet-stream').send(fs.createReadStream(abs));
});

app.get('/ws', { websocket: true }, (socket) => {
  const off = bus.on((event) => socket.send(JSON.stringify(event)));
  // La pagina dice quale chat sta guardando: Ciccio non avvisa di quella.
  socket.on('message', (raw: Buffer) => {
    try {
      const m = JSON.parse(raw.toString()) as { type?: string; chatId?: string | null };
      if (m.type === 'viewing') setViewing(socket, typeof m.chatId === 'string' ? m.chatId : null);
    } catch { /* messaggio non valido */ }
  });
  socket.on('close', () => { off(); dropSocket(socket); });
});

if (fs.existsSync(config.webDir)) {
  await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'non trovato' });
    return reply.sendFile('index.html');
  });
}

// Giri interrotti dall'ultimo spegnimento: riprendono da soli (restart.ts).
resumeAfterRestart();
// systemd ferma il servizio con SIGTERM (KillMode=mixed: solo a questo processo): i giri al lavoro hanno qualche
// secondo per finire, poi si annota chi era a metà e si esce.
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void shutdown(sig, () => app.close()));

await app.listen({ host: config.host, port: config.port });
