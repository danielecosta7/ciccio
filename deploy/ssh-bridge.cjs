#!/usr/bin/env node
// Ponte SSH della chat, per ciccio-ssh-proxy (deploy/ssh-proxy.sh; install.sh lo copia in ~/.local/bin/ciccio-ssh-bridge.cjs).
// Chiede "host porta" al socket di CICCIO_SSH_BRIDGE (server/src/sshBridge.ts) e:
//   OK        → passa stdin e stdout per tutta la connessione (attraverso il PC con il companion); esce con 0
//   NO        → esce con 3: nessun PC fa da ponte verso quell'host, ciccio-ssh-proxy va diretto come sempre
//   ERR …     → scrive il motivo su stderr ed esce con 1
// Socket che non c'è o non risponde: 3, come NO. Prima dell'OK stdin non si legge: con NO la riga di versione che
// ssh ha già scritto resta nella pipe per socat. CommonJS apposta: si lancia con node senza package.json accanto.
'use strict';
const net = require('node:net');

const [host, port] = process.argv.slice(2);
const where = process.env.CICCIO_SSH_BRIDGE;
if (!where || !host || !/^\d{1,5}$/.test(port || '')) process.exit(3);

const fail = (code, msg) => {
  if (msg) process.stderr.write(`ciccio-ssh-proxy: ${msg}\n`);
  process.exit(code);
};

const sock = net.connect(where);
let buf = Buffer.alloc(0);
let open = false;
// Il PC ha 10 secondi per collegarsi, Ciccio ne aspetta 20 per la risposta: oltre, qualcosa non va.
const timer = setTimeout(() => fail(1, `il ponte SSH non ha risposto per ${host}:${port}`), 30000);

sock.on('error', (e) => (open ? fail(1, `ponte SSH interrotto: ${e.message}`) : fail(3)));
sock.on('connect', () => sock.write(`${host} ${port}\n`));
sock.on('data', function first(chunk) {
  buf = Buffer.concat([buf, chunk]);
  const nl = buf.indexOf(0x0a);
  if (nl < 0) { if (buf.length > 1000) fail(1, 'risposta del ponte SSH non valida'); return; }
  const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
  const rest = buf.subarray(nl + 1);
  if (line === 'NO') fail(3);
  if (line.startsWith('ERR')) fail(1, `ponte SSH verso ${host}:${port}: ${line.slice(3).trim() || 'rifiutato'}`);
  if (line !== 'OK') fail(1, 'risposta del ponte SSH non valida');
  clearTimeout(timer);
  open = true;
  sock.off('data', first);
  if (rest.length) process.stdout.write(rest);
  sock.pipe(process.stdout);
  process.stdin.pipe(sock);
});
sock.on('close', () => {
  if (!open) fail(1, `il ponte SSH ha chiuso senza rispondere per ${host}:${port}`);
  // Prima si finisce di scrivere a ssh quello che è arrivato.
  process.stdout.write('', () => process.exit(0));
});
