// Programma di prova per il server «comandi»: stampa gli argomenti ricevuti (in JSON, per controllare che
// arrivino uno per uno, senza shell) e copia il file di ingresso in quello di uscita.
//   node prova-comando.mjs --in=<file> <uscita> <numero> <modo>
// modo: ok | fallisci (esce con 3) | dormi (resta acceso finché non lo chiudono)
import fs from 'node:fs';

const [inArg, out, n, modo] = process.argv.slice(2);
console.log(JSON.stringify({ argomenti: process.argv.slice(2), cwd: process.cwd() }));
if (modo === 'dormi') setInterval(() => undefined, 1000);
else if (modo === 'fallisci') { console.error('qualcosa non va'); process.exit(3); }
else {
  fs.writeFileSync(out, `${fs.readFileSync(inArg.replace(/^--in=/, ''), 'utf8')} x${n}`);
  console.error('fatto');
}
