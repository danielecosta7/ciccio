// Prova della ripresa di un server MCP del PC che perde la sessione (Affinity riavviato o caduto):
// un server SSE finto che, come Affinity, risponde «Session not initialized» a una sessione senza initialize.
// Il companion deve riaprire il collegamento da solo e riprovare, e dirlo nel registro.
//
//   pnpm exec tsx companion/test/ripresa.ts

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { LocalServer } from '../src/local.js';
import { logToFile } from '../src/log.js';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ciccio-ripresa-')));
const logPath = path.join(tmp, 'companion.log');
logToFile(logPath);

let failed = false;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? '✓' : '✗'} ${what}`); if (!cond) failed = true; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = async (f: () => boolean, ms = 15_000) => { for (const t0 = Date.now(); !f(); ) { if (Date.now() - t0 > ms) return false; await sleep(100); } return true; };

/** Il server finto, con un contatore di avvii per vedere che risponde quello nuovo. */
const forgetters = new Set<() => void>();
/** Tutte le sessioni aperte dimenticano di essere state inizializzate, senza far cadere il flusso. */
const forgetSessions = () => { for (const f of forgetters) f(); };

function fakeAffinity(port: number, generation: string): Promise<http.Server> {
  const sessions = new Map<string, SSEServerTransport>();
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      sessions.set(transport.sessionId, transport);
      const mcp = new McpServer({ name: 'affinity-finto', version: '1' });
      mcp.registerTool('quale', { description: 'Quale avvio risponde.' }, () => ({ content: [{ type: 'text', text: generation }] }));
      await mcp.connect(transport);
      // Come Affinity: una richiesta prima di initialize non è accettata.
      const inner = transport.onmessage!;
      let initialized = false;
      forgetters.add(() => { initialized = false; });
      transport.onmessage = (msg: JSONRPCMessage) => {
        if ('method' in msg && msg.method === 'initialize') initialized = true;
        if ('method' in msg && 'id' in msg && !initialized) {
          void transport.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Session not initialized' } });
          return;
        }
        inner(msg);
      };
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const t = sessions.get(url.searchParams.get('sessionId') ?? '');
      if (!t) { res.writeHead(404).end('Session not found'); return; }
      await t.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

const stop = (srv: http.Server) => new Promise<void>((resolve) => { srv.close(() => resolve()); srv.closeAllConnections(); });
const quale = async (s: LocalServer) => ((await s.call('quale', {}, new AbortController().signal)).content[0] as { text: string }).text;
const logText = () => fs.readFileSync(logPath, 'utf8');

let a = await fakeAffinity(0, 'primo');
const port = (a.address() as AddressInfo).port;
const local = new LocalServer('affinity', { type: 'sse', url: `http://127.0.0.1:${port}/sse` });
await local.start();
ok(local.state.status === 'online' && local.state.tools.length === 1, 'collegato al server finto');
ok(await quale(local) === 'primo', 'chiamata normale');

// ── Il server riparte: lo flusso cade, la libreria si riapre da sola su una sessione non inizializzata ──
await stop(a);
a = await fakeAffinity(port, 'secondo');
ok(await wait(() => /errore di collegamento/.test(logText())), 'la caduta del flusso finisce nel registro');
ok(await wait(() => local.state.status === 'online'), 'il companion si ricollega da solo, senza chiamate');
ok(await quale(local) === 'secondo', 'dopo la ripartenza risponde il server nuovo (niente «Session not initialized»)');

// ── Il server perde la sessione ma il flusso resta aperto (nessun errore di collegamento): la chiamata si ricollega e riprova ──
forgetSessions();
let risposta: string;
try { risposta = await quale(local); } catch (e) { risposta = `errore: ${(e as Error).message}`; }
ok(risposta === 'secondo', `sessione persa: la chiamata riesce da sola dopo il ricollegamento (${risposta})`);
ok(/ha perso la sessione \(MCP error -32600: Session not initialized\) · mi ricollego e riprovo/.test(logText()), 'il registro dice cosa è successo');
// Due chiamate insieme sulla sessione persa: un solo ricollegamento.
forgetSessions();
const collegamenti = () => (logText().match(/● affinity: 1 strumenti/g) ?? []).length;
const prima = collegamenti();
const due = await Promise.all([quale(local), quale(local)].map((p) => p.catch((e: Error) => `errore: ${e.message}`)));
// La seconda può essere già in volo quando la prima chiude il vecchio collegamento: non si sa se il server l'abbia
// eseguita, quindi non si rilancia alla cieca e l'errore resta (è quello onesto).
ok(due.includes('secondo') && due.every((r) => r === 'secondo' || /Connection closed/.test(r)), `due chiamate insieme su una sessione persa: nessuna resta appesa (${due.join(' | ')})`);
ok(collegamenti() - prima === 1, 'e il collegamento si riapre una volta sola');
ok(await quale(local) === 'secondo', 'poi risponde normalmente');

// ── Il server riparte: una chiamata che arriva mentre il companion si ricollega aspetta, non fallisce ──
const cadute = () => (logText().match(/errore di collegamento/g) ?? []).length;
const prime = cadute();
const primi = collegamenti();
await stop(a);
a = await fakeAffinity(port, 'terzo');
ok(await wait(() => cadute() > prime), 'la ripartenza viene notata');
ok(await wait(() => collegamenti() > primi && local.state.status === 'online', 20_000), 'e il companion si ricollega in pochi secondi (non ai 30 s)');
ok(await quale(local) === 'terzo', 'risponde il server nuovo');

// ── Server spento del tutto: errore chiaro, e quando torna si riprende ──
await stop(a);
let errore = '';
try { await quale(local); } catch (e) { errore = (e as Error).message; }
ok(/non è disponibile|Unable to connect|fetch failed|SSE error|Connection closed/i.test(errore), `server spento: errore chiaro (${errore.slice(0, 90)})`);
a = await fakeAffinity(port, 'quarto');
ok(await wait(() => local.state.status === 'online', 45_000), 'server tornato: il companion lo riprende');
ok(await quale(local) === 'quarto', 'e risponde');

await local.stop();
await stop(a);
console.log(failed ? '\nQualcosa non va.' : '\nTutto a posto.');
process.exit(failed ? 1 : 0);
