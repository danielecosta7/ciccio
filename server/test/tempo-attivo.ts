// Tempo dedicato a una chat o a un progetto (shared/worktime.ts): pause lunghe, giri automatici, chat in parallelo.
// Solo i conti, senza server né database.
//
//   pnpm exec tsx server/test/tempo-attivo.ts

import assert from 'node:assert/strict';
import { IDLE_GAP_MS } from '../../shared/consumi.js';
import { setTimeZone } from '../../shared/tz.js';
import { activeMs, startOfDay, workTime, type WorkEvent } from '../../shared/worktime.js';

const MIN = 60_000;
const ev = (min: number, start: WorkEvent['start'] = null): WorkEvent => ({ ts: 1_000_000_000_000 + min * MIN, start });

// 1. Nessun messaggio, o uno solo: niente tempo.
assert.equal(activeMs([]), 0);
assert.equal(activeMs([ev(0, 'user')]), 0);

// 2. Le pause fino al limite contano, quelle più lunghe no.
assert.equal(activeMs([ev(0, 'user'), ev(2), ev(4)]), 4 * MIN, 'due pause da 2 minuti');
assert.equal(activeMs([ev(0, 'user'), ev(IDLE_GAP_MS / MIN)]), IDLE_GAP_MS, 'esattamente il limite conta');
assert.equal(activeMs([ev(0, 'user'), ev(IDLE_GAP_MS / MIN + 1)]), 0, 'oltre il limite eri altrove');
// Dopo una pausa lunga si riparte da capo: la pausa non conta ma il lavoro dopo sì.
assert.equal(activeMs([ev(0, 'user'), ev(60, 'user'), ev(62)]), 2 * MIN);

// 3. Un giro partito da una routine o da Ciccio non conta, nemmeno l'attesa che lo apre; quello dell'utente dopo sì.
assert.equal(activeMs([ev(0, 'user'), ev(1), ev(2, 'auto'), ev(3), ev(4), ev(5, 'user'), ev(6)]), 1 * MIN + 1 * MIN + 1 * MIN,
  'conta 0→1 (utente), 4→5 (l\'utente scrive) e 5→6; non 1→2, 2→3, 3→4');

// 4. Eventi con la stessa data non aggiungono niente e non rompono la sequenza.
assert.equal(activeMs([ev(0, 'user'), ev(0), ev(1)]), 1 * MIN);

// 5. Il progetto è una sola sequenza: due chat in parallelo fanno una volta il tempo, non la somma.
const a = [ev(0, 'user'), ev(2), ev(4)];
const b = [ev(1, 'user'), ev(3), ev(5)];
const both = [...a, ...b].sort((x, y) => x.ts - y.ts);
assert.equal(activeMs(a), 4 * MIN);
assert.equal(activeMs(b), 4 * MIN);
assert.equal(activeMs(both), 5 * MIN, 'da 0 a 5 minuti: cinque, non otto');

// 6. Oggi e 7 giorni: contano le pause che finiscono dopo l'inizio della finestra.
setTimeZone('Europe/Rome');
const now = Date.UTC(2026, 10, 10, 12, 0, 0); // 10/11/2026 13:00 a Roma (ora solare)
const midnight = startOfDay(now);
assert.equal(midnight, Date.UTC(2026, 10, 9, 23, 0, 0), 'mezzanotte di Roma, in UTC');
const at = (t: number, start: WorkEvent['start'] = null): WorkEvent => ({ ts: t, start });
const project = [
  at(now - 3 * 86_400_000, 'user'), at(now - 3 * 86_400_000 + 2 * MIN), // 3 giorni fa, 2 minuti
  at(midnight - 4 * MIN, 'user'), at(midnight - 2 * MIN), // ieri sera, 2 minuti
  at(midnight + 10 * MIN, 'user'), at(midnight + 13 * MIN), // stamattina, 3 minuti
];
const t = workTime(project.slice(4), project, now);
assert.equal(t.chatMs, 3 * MIN);
assert.equal(t.projectMs, 7 * MIN);
assert.equal(t.todayMs, 3 * MIN);
assert.equal(t.weekMs, 7 * MIN);
assert.equal(workTime([], [], now).projectMs, 0);

console.log('tempo-attivo: ok');
