// Notifiche doppie: con l'app e il companion dello stesso PC collegati, l'avviso arriva solo all'app;
// con l'app spenta torna al companion. Server di Ciccio vero (in questo processo), client WebSocket finti.
//
//   CICCIO_PORT=8791 CICCIO_PROJECTS_DIR=<repo finti> CICCIO_DATA_DIR=<dati vuoti> pnpm exec tsx desktop/test/notifiche-doppie.ts

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

await import('../../server/src/index.js');
const { deviceStore, desktopStore, store } = await import('../../server/src/db.js');
const { bus } = await import('../../server/src/bus.js');

const base = `ws://127.0.0.1:${process.env.CICCIO_PORT ?? 8787}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const companionToken = `ccp_${randomBytes(16).toString('hex')}`;
deviceStore.add(`d${randomBytes(4).toString('hex')}`, 'macprova', sha(companionToken));
const appToken = `cda_${randomBytes(16).toString('hex')}`;
desktopStore.add(`a${randomBytes(4).toString('hex')}`, 'Mac di prova', sha(appToken), 'darwin-arm64');

function client(path: string, token: string, hello: { method: string; params: unknown }) {
  const got: string[] = [];
  const ws = new WebSocket(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()) as { method?: string }; if (m.method) got.push(m.method); });
  const open = new Promise<void>((r) => ws.on('open', () => { ws.send(JSON.stringify({ jsonrpc: '2.0', ...hello })); r(); }));
  return { ws, got, open };
}

const agentId = store.agents()[0]?.id;
assert.ok(agentId, 'serve almeno un repo in CICCIO_PROJECTS_DIR');
const notice = () => bus.emit({ type: 'message', message: store.addMessage({ chatId: '__ciccio', agentId: '__ciccio' }, 'agent', 'avviso di prova', { kind: 'notice', agentId, chatId: 'x', chatTitle: 'prova', tone: 'done' }) });

const comp = client('/companion', companionToken, { method: 'companion/hello', params: { protocol: 1, version: '9.9.9', platform: 'darwin-arm64', servers: [], notifications: true } });
const app = client('/desktop', appToken, { method: 'desktop/hello', params: { version: '0.1.0', platform: 'darwin-arm64', companion: sha(companionToken) } });
await Promise.all([comp.open, app.open]);
await wait(300);

notice();
await wait(300);
assert.ok(app.got.includes('desktop/notify'), 'l\'app riceve l\'avviso');
assert.ok(!comp.got.includes('companion/notify'), 'il companion dello stesso PC non lo riceve');
console.log('✓ app e companion accesi: notifica solo all\'app');

app.ws.close();
await wait(300);
notice();
await wait(300);
assert.ok(comp.got.includes('companion/notify'), 'con l\'app spenta torna al companion');
console.log('✓ app spenta: notifica al companion');

comp.ws.close();
process.exit(0);
