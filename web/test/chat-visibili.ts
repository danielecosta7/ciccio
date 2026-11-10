// Quali chat di un progetto mostra l'elenco a schermo intero (web/src/chatLimit.ts): al massimo 2,
// finché non chiedi le altre; chi lavora, è in coda, aspetta te o ha dato errore non si nasconde mai.
// Solo i conti, senza interfaccia.
//
//   pnpm exec tsx web/test/chat-visibili.ts

import assert from 'node:assert/strict';
import { CHATS_PER_REPO, needsSight, visibleChats } from '../src/chatLimit.js';

type C = Parameters<typeof visibleChats>[0][number];

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
/** Chat ferma, con l'ultima risposta `days` giorni fa. */
const idle = (id: string, days: number): C => ({
  id, running: false, queued: false, status: 'idle', activity: 'idle', pendingApprovals: 0,
  lastReply: T0 - days * DAY, lastActivity: T0 - days * DAY, createdAt: T0 - 30 * DAY,
});
const working = (id: string, days = 5): C => ({ ...idle(id, days), running: true, status: 'work', activity: 'work' });
const queued = (id: string, days = 5): C => ({ ...idle(id, days), queued: true, status: 'work' });
const asks = (id: string, days = 5): C => ({ ...idle(id, days), status: 'wait' });
const approval = (id: string, days = 5): C => ({ ...idle(id, days), running: true, status: 'wait', activity: 'wait', pendingApprovals: 1 });
const failed = (id: string, days = 5): C => ({ ...idle(id, days), status: 'block' });

const ids = (r: { shown: C[] }) => r.shown.map((c) => c.id);

assert.equal(CHATS_PER_REPO, 2);

// 1. Poche chat: si vedono tutte, niente da aprire.
assert.deepEqual(visibleChats([]), { shown: [], hidden: 0 });
assert.deepEqual(ids(visibleChats([idle('a', 1)])), ['a']);
assert.deepEqual(visibleChats([idle('a', 1), idle('b', 2)]).hidden, 0);

// 2. Tutte ferme: le 2 più recenti, le altre nascoste e contate.
let r = visibleChats([idle('vecchia', 9), idle('b', 2), idle('a', 1), idle('c', 3)]);
assert.deepEqual(ids(r), ['a', 'b']);
assert.equal(r.hidden, 2);

// 3. Chi lavora non si nasconde, e conta nelle 2: una al lavoro + la più recente delle ferme.
r = visibleChats([idle('a', 1), idle('b', 2), working('w', 8), idle('c', 3)]);
assert.deepEqual(ids(r), ['w', 'a'], 'prima chi lavora, poi la più recente');
assert.equal(r.hidden, 2);

// 4. Il limite si amplia: tre al lavoro restano tutte e tre, senza ferme.
r = visibleChats([idle('a', 1), working('w1'), working('w2', 6), working('w3', 7), idle('b', 2)]);
assert.deepEqual(ids(r), ['w1', 'w2', 'w3']);
assert.equal(r.hidden, 2);

// 5. In coda e in attesa di te (permesso, domanda) valgono come al lavoro.
r = visibleChats([idle('a', 1), idle('b', 2), idle('c', 3), queued('q', 9)]);
assert.deepEqual(ids(r), ['q', 'a']);
r = visibleChats([idle('a', 1), idle('b', 2), idle('c', 3), asks('d', 9)]);
assert.deepEqual(ids(r), ['d', 'a'], 'una domanda aspetta te');
r = visibleChats([idle('a', 1), idle('b', 2), idle('c', 3), approval('p', 9)]);
assert.deepEqual(ids(r), ['p', 'a'], 'un permesso da dare');
r = visibleChats([idle('a', 1), idle('b', 2), idle('c', 3), failed('e', 9)]);
assert.deepEqual(ids(r), ['a', 'e'], 'una chat andata in errore serve a te (nell\'elenco sta tra le ferme, per data)');
// Un solo campo basta: il permesso in sospeso anche se lo stato non è ancora aggiornato.
assert.equal(needsSight({ ...idle('x', 1), pendingApprovals: 2 }), true);
assert.equal(needsSight({ ...idle('x', 1), activity: 'wait' }), true);
assert.equal(needsSight(idle('x', 1)), false);

// 6. La chat aperta si vede sempre, anche se è la più vecchia, e conta nelle 2.
r = visibleChats([idle('a', 1), idle('b', 2), idle('aperta', 20)], { currentId: 'aperta' });
assert.deepEqual(ids(r), ['a', 'aperta']);
assert.equal(r.hidden, 1);
r = visibleChats([idle('a', 1), idle('b', 2), idle('c', 3), working('w'), idle('aperta', 20)], { currentId: 'aperta' });
assert.deepEqual(ids(r), ['w', 'aperta'], 'chi lavora + quella aperta: già 2, nessuna ferma in più');
assert.equal(r.hidden, 3);
// La chat aperta che è anche al lavoro non si conta due volte.
r = visibleChats([working('w'), idle('a', 1), idle('b', 2)], { currentId: 'w' });
assert.deepEqual(ids(r), ['w', 'a']);

// 7. Ordine: lo stesso dell'elenco intero (chi lavora, chi aspetta, poi i più recenti), non quello d'arrivo.
r = visibleChats([idle('a', 1), asks('d', 4), working('w', 6), idle('b', 2)]);
assert.deepEqual(ids(r), ['w', 'd'], 'al lavoro, poi in attesa: già 2 che servono, nessuna ferma in più');
assert.equal(r.hidden, 2);

// 8. Una chat nuova mai usata (senza risposte) conta dal giorno in cui è nata, non sparisce dietro quelle vecchie.
const fresh: C = { ...idle('nuova', 0), lastReply: null, lastActivity: null, createdAt: T0 - 1_000 };
r = visibleChats([idle('a', 5), idle('b', 6), idle('c', 7), fresh]);
assert.deepEqual(ids(r), ['a', 'nuova'], 'la nuova è tra le 2 visibili (nell\'elenco sta dopo: senza risposte)');
assert.equal(r.hidden, 2);

// 9. Limite diverso, e non cambia l'elenco di partenza.
const base = [idle('a', 1), idle('b', 2), idle('c', 3), idle('d', 4)];
const copy = [...base];
assert.deepEqual(ids(visibleChats(base, { limit: 3 })), ['a', 'b', 'c']);
assert.deepEqual(ids(visibleChats(base, { limit: 1 })), ['a']);
assert.deepEqual(base, copy, 'l\'elenco di partenza resta com\'era');

// 10. Una chat che finisce di lavorare esce solo se ce ne sono altre abbastanza: l'elenco non salta.
const before = visibleChats([working('w'), idle('a', 1), idle('b', 2)]);
assert.deepEqual(ids(before), ['w', 'a']);
const after = visibleChats([{ ...idle('w', 0) }, idle('a', 1), idle('b', 2)]);
assert.deepEqual(ids(after), ['w', 'a'], 'appena finita è la più recente: resta');

console.log('ok: chat visibili per progetto');
