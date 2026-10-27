// Dopo `bun build --windows-icon`: fa usare a Windows il gruppo di icone con tutte le misure (vedi fixIconGroups
// in src/pe.ts), altrimenti l'icona dell'.exe è la 16×16 ingrandita. Uso: bun companion/fix-exe-icon.ts file.exe
import fs from 'node:fs';
import { fixIconGroups, iconSizes } from './src/pe.js';

const file = process.argv[2];
if (!file) { console.error('Uso: bun companion/fix-exe-icon.ts file.exe'); process.exit(2); }
const exe = fs.readFileSync(file);
const changed = fixIconGroups(exe);
if (changed) fs.writeFileSync(file, exe);
const sizes = iconSizes(exe);
console.log(`${file}: ${changed} gruppi di icone corretti; Windows usa ${sizes.join(', ')}`);
if (!sizes.includes(256) || sizes.length < 2) { console.error('L\'icona usata da Windows non ha tutte le misure.'); process.exit(1); }
