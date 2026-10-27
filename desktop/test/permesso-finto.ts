// Prova dell'app desktop con un server di Ciccio locale: aspetta che l'app si colleghi, poi chiede un permesso
// e una domanda sì/no come farebbe un agente (askApproval/askQuestion, salvati nel database) e stampa cosa
// ha deciso l'utente dalla notifica; infine un avviso senza pulsanti, il cui clic deve portare la finestra
// già aperta su quella chat. Nessun modello coinvolto.
//
//   CICCIO_PORT=8790 CICCIO_PROJECTS_DIR=<repo finti> CICCIO_DATA_DIR=<dati> CICCIO_WEB_DIR=$PWD/dist/web \
//   CICCIO_PUBLIC_ORIGIN=http://127.0.0.1:8790 pnpm exec tsx desktop/test/permesso-finto.ts [progetto]
//
// L'app va avviata con config.json { "server": "http://127.0.0.1:8790" } (o CICCIO_APP_SERVER), e si collega
// con il codice da confermare in Impostazioni › App.

await import('../../server/src/index.js');
const { askApproval, askQuestion, createChat, newRunning, trackSession, untrackSession } = await import('../../server/src/agents.js');
const { desktopApps } = await import('../../server/src/desktop.js');
const { agentEvents } = await import('../../server/src/bus.js');
const { isViewing } = await import('../../server/src/presence.js');

const agentId = process.argv[2] ?? 'sito-prova';
const log = (s: string) => console.log(`\n[prova] ${s}`);

log('aspetto che l\'app si colleghi…');
while (!desktopApps().some((a) => a.online)) await new Promise((r) => setTimeout(r, 500));
log(`app collegata: ${desktopApps().filter((a) => a.online).map((a) => a.name).join(', ')}`);

const chat = createChat(agentId, 'Prova notifiche app');
const thread = { chatId: chat.id, agentId };
const state = newRunning(chat.id, agentId);
trackSession(chat.id, state);

log('permesso: Bash «touch prova-app.txt» (Consenti o Rifiuta dalla notifica)');
const p = await askApproval(thread, state, 'Bash', { command: 'touch prova-app.txt', description: 'Crea un file di prova' }, 'prova dell\'app desktop', state.abort.signal);
log(`risultato del permesso: ${JSON.stringify(p)}`);

log('domanda sì/no (Sì o No dalla notifica)');
const q = await askQuestion(thread, state, { questions: [{ question: 'Pubblico la versione di prova?', header: 'Prova', multiSelect: false, options: [{ label: 'Sì', description: 'pubblica' }, { label: 'No', description: 'aspetta' }] }] }, state.abort.signal);
log(`risultato della domanda: ${JSON.stringify(q)}`);

untrackSession(chat.id);

log('avviso senza pulsanti: il clic deve aprire la chat «Prova notifiche app» nella finestra dell\'app');
agentEvents.notice({ agentId, chatId: chat.id, text: 'Prova del clic: apri questa notifica.', tone: 'done' });
const until = Date.now() + 5 * 60_000;
while (!isViewing(chat.id) && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
log(isViewing(chat.id) ? `chat aperta dalla notifica (/agente/${agentId}/${chat.id})` : 'la chat non si è aperta entro 5 minuti');
log('fatto');
process.exit(0);
