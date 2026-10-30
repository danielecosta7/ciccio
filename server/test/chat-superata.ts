// Ciccio e le chat che vanno avanti: l'utente risponde direttamente a una chat, poi torna su Ciccio.
// Gli avvisi su quella chat diventano «già gestiti» e Ciccio sa che la chat è andata avanti dopo l'ultima volta che l'ha vista.
// Server di Ciccio vero (in questo processo), nessuna chiamata a Claude.
//
//   CICCIO_PORT=8792 CICCIO_PROJECTS_DIR=<cartella con un repo git> CICCIO_DATA_DIR=<dati vuoti> pnpm exec tsx server/test/chat-superata.ts

import assert from 'node:assert/strict';

await import('../../server/src/index.js');
const { store } = await import('../../server/src/db.js');
const { bus, agentEvents } = await import('../../server/src/bus.js');
const { createChat } = await import('../../server/src/agents.js');
const { markSeen, userWroteSince } = await import('../../server/src/ciccio.js');
const { CICCIO_THREAD } = await import('../../shared/types.js');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CICCIO = { chatId: CICCIO_THREAD, agentId: CICCIO_THREAD };
const agentId = store.agents()[0]?.id;
assert.ok(agentId, 'serve almeno un repo in CICCIO_PROJECTS_DIR');
const chat = createChat(agentId, 'Prova avvisi');
const thread = { chatId: chat.id, agentId };

const notices = () => store.messages(CICCIO_THREAD, 200).filter((m) => m.meta?.kind === 'notice' && m.meta.chatId === chat.id);
const ask = (id: string, status: 'pending' | 'allowed') =>
  bus.emit({ type: 'approval', approval: { id, chatId: chat.id, agentId, tool: 'Bash', summary: 'Bash: ls', input: { command: 'ls' }, ts: Date.now(), status } });

// 1. Un permesso in attesa: l'avviso nasce vivo. Deciso in chat: si spegne.
ask('a1', 'pending');
await wait(100);
assert.equal(notices().length, 1, 'un avviso per il permesso');
assert.equal((notices()[0].meta as { superseded?: boolean }).superseded, undefined, 'nasce vivo');
ask('a1', 'allowed');
await wait(100);
assert.equal((notices()[0].meta as { superseded?: boolean }).superseded, true, 'deciso: avviso superato');
console.log('✓ permesso deciso: l\'avviso si spegne');

// 2. Un avviso vivo (messaggio con l'ultimo giro): l'utente scrive direttamente alla chat → superato.
const live = store.addMessage(CICCIO, 'agent', 'X ti fa una domanda: dove metto la pagina?', { kind: 'notice', agentId, chatId: chat.id, chatTitle: chat.title, tone: 'wait' });
bus.emit({ type: 'message', message: live });
markSeen(chat.id);
assert.equal(userWroteSince(chat.id).length, 0, 'appena vista, nessun messaggio dell\'utente dopo');
await wait(5);
store.addMessage(thread, 'user', 'Mettila in /debug');
agentEvents.userWrote(chat.id);
assert.equal((store.message(live.id)!.meta as { superseded?: boolean }).superseded, true, 'avviso superato dopo il messaggio diretto');
assert.equal(userWroteSince(chat.id).length, 1, 'Ciccio vede che la chat è andata avanti');
console.log('✓ messaggio diretto alla chat: avviso superato e chat «andata avanti» per Ciccio');

// 3. Ciccio rilegge la chat: da adesso è vista. Un messaggio di Ciccio stesso non conta come «andata avanti».
await wait(5);
markSeen(chat.id);
assert.equal(userWroteSince(chat.id).length, 0, 'dopo la lettura non è più avanti');
await wait(5);
store.addMessage(thread, 'ciccio', 'istruzione di Ciccio');
assert.equal(userWroteSince(chat.id).length, 0, 'i messaggi di Ciccio non contano');
console.log('✓ lettura e messaggi di Ciccio azzerano o non contano');

// 4. Una chat che Ciccio non ha mai visto non blocca niente.
const other = createChat(agentId, 'Mai vista');
store.addMessage({ chatId: other.id, agentId }, 'user', 'ciao');
assert.equal(userWroteSince(other.id).length, 0, 'senza segno non si blocca');
console.log('✓ chat mai vista: nessun blocco');

process.exit(0);
