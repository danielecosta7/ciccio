// Un .exe di Windows dichiara nell'intestazione PE se è un programma "console" (apre una finestra
// del prompt) o "GUI" (nessuna finestra). È lo stesso cambio che fa `bun build --windows-hide-console`,
// che però funziona solo compilando su Windows: qui lo fa il companion su una copia di se stesso.

const SUBSYSTEM_GUI = 2;
const SUBSYSTEM_CONSOLE = 3;

/** Offset del campo Subsystem, oppure errore se il file non è un .exe PE valido. */
function subsystemOffset(exe: Buffer): number {
  if (exe.length < 0x40 || exe.toString('latin1', 0, 2) !== 'MZ') throw new Error('non è un eseguibile Windows (manca MZ)');
  const pe = exe.readUInt32LE(0x3c);
  if (pe + 24 + 70 > exe.length || exe.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('intestazione PE non trovata');
  const optional = pe + 24;
  const magic = exe.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('intestazione opzionale PE sconosciuta');
  // Stessa posizione in PE32 e PE32+.
  return optional + 68;
}

export function subsystem(exe: Buffer): 'gui' | 'console' | number {
  const v = exe.readUInt16LE(subsystemOffset(exe));
  return v === SUBSYSTEM_GUI ? 'gui' : v === SUBSYSTEM_CONSOLE ? 'console' : v;
}

/** Copia dell'eseguibile che parte senza finestra. */
export function withoutConsole(exe: Buffer): Buffer {
  const out = Buffer.from(exe);
  const at = subsystemOffset(out);
  if (out.readUInt16LE(at) !== SUBSYSTEM_CONSOLE && out.readUInt16LE(at) !== SUBSYSTEM_GUI) throw new Error('sottosistema PE inatteso');
  out.writeUInt16LE(SUBSYSTEM_GUI, at);
  return out;
}

const RT_GROUP_ICON = 14;

interface ResEntry { named: boolean; id: number; dataEntry: number | null; children: number | null }

/** Le voci di una directory delle risorse (offset nel file), con l'offset della voce dati o della sottodirectory. */
function resDir(exe: Buffer, base: number, at: number): ResEntry[] {
  const named = exe.readUInt16LE(at + 12), ids = exe.readUInt16LE(at + 14);
  return Array.from({ length: named + ids }, (_, i) => {
    const e = at + 16 + i * 8, id = exe.readUInt32LE(e), to = exe.readUInt32LE(e + 4);
    const sub = (to & 0x80000000) !== 0, target = base + (to & 0x7fffffff);
    return { named: (id & 0x80000000) !== 0, id: id & 0x7fffffff, dataEntry: sub ? null : target, children: sub ? target : null };
  });
}

/**
 * Gruppi di icone dell'.exe nell'ordine in cui li legge Windows (prima quelli con un nome, poi per id):
 * offset della voce dati (RVA e dimensione del GRPICONDIR) e misure delle immagini.
 */
function iconGroups(exe: Buffer): { entry: number; sizes: number[] }[] {
  subsystemOffset(exe); // controlla che sia un .exe PE
  const pe = exe.readUInt32LE(0x3c);
  const sections = exe.readUInt16LE(pe + 6), optSize = exe.readUInt16LE(pe + 20), opt = pe + 24;
  const rsrcRva = exe.readUInt32LE(opt + (exe.readUInt16LE(opt) === 0x20b ? 112 : 96) + 2 * 8);
  if (!rsrcRva) return [];
  const secs = Array.from({ length: sections }, (_, i) => {
    const s = opt + optSize + i * 40;
    return { va: exe.readUInt32LE(s + 12), size: Math.max(exe.readUInt32LE(s + 8), exe.readUInt32LE(s + 16)), raw: exe.readUInt32LE(s + 20) };
  });
  const fileOffset = (rva: number) => {
    const s = secs.find((x) => rva >= x.va && rva < x.va + x.size);
    if (!s) throw new Error(`RVA ${rva} fuori dalle sezioni`);
    return rva - s.va + s.raw;
  };
  const base = fileOffset(rsrcRva);
  const groupsDir = resDir(exe, base, base).find((t) => !t.named && t.id === RT_GROUP_ICON)?.children;
  if (groupsDir == null) return [];
  return resDir(exe, base, groupsDir).map((g) => {
    const entry = g.children != null ? resDir(exe, base, g.children)[0]?.dataEntry : g.dataEntry;
    if (entry == null) throw new Error('gruppo di icone senza dati');
    const at = fileOffset(exe.readUInt32LE(entry));
    return { entry, sizes: Array.from({ length: exe.readUInt16LE(at + 4) }, (_, i) => exe[at + 6 + i * 14] || 256) };
  });
}

/** Misure del primo gruppo di icone, quello che usa Windows. */
export function iconSizes(exe: Buffer): number[] {
  return iconGroups(exe)[0]?.sizes ?? [];
}

/**
 * Icona nitida a ogni misura. `bun build --windows-icon` aggiunge il gruppo di icone del file .ico (id 0, tutte le
 * misure) ma lascia quello originale di Bun, con un nome, che Windows legge per primo: dichiara un'icona 256×256 e
 * punta all'icona numero 1, che dopo l'aggiunta è la 16×16 del nostro .ico. Risultato: Esplora risorse, la barra delle
 * applicazioni e la richiesta di 1Password mostrano 16 pixel ingranditi. Qui ogni altro gruppo viene fatto puntare ai
 * dati del gruppo con più misure. Restituisce quanti gruppi ha cambiato.
 */
export function fixIconGroups(exe: Buffer): number {
  const groups = iconGroups(exe);
  if (groups.length < 2) return 0;
  const best = groups.reduce((a, b) => (b.sizes.length > a.sizes.length ? b : a));
  let changed = 0;
  for (const g of groups) {
    if (exe.readUInt32LE(g.entry) === exe.readUInt32LE(best.entry)) continue;
    exe.writeUInt32LE(exe.readUInt32LE(best.entry), g.entry);         // RVA dei dati
    exe.writeUInt32LE(exe.readUInt32LE(best.entry + 4), g.entry + 4); // dimensione
    changed++;
  }
  return changed;
}
