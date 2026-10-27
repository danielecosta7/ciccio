// Orari delle routine: cron a 5 campi (minuto ora giorno mese giorno-della-settimana), nel fuso di Ciccio (shared/tz.ts).
// Condiviso tra server (scheduler) e pagina (anteprima mentre l'utente scrive). Niente librerie: serve poco.
//   *  ogni valore · 5  un valore · 1-5  intervallo · */15 o 8-18/2  a passi · 1,15,30  elenco
// Giorno della settimana 0-7 (0 e 7 = domenica). Come in cron classico: se giorno del mese e giorno della
// settimana sono entrambi ristretti, basta che uno dei due combaci.

import { timeZone, zoneVersion } from './tz.js';

interface Field { values: Set<number>; any: boolean }
export interface Cron { minute: Field; hour: Field; day: Field; month: Field; weekday: Field; source: string }

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NAMES = ['minuto', 'ora', 'giorno del mese', 'mese', 'giorno della settimana'];

function parseField(raw: string, i: number): Field {
  const [lo, hi] = RANGES[i];
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`${NAMES[i]}: «${part}» non è valido`);
    const step = m[4] ? Number(m[4]) : 1;
    const from = m[1] === '*' ? lo : Number(m[2]);
    const to = m[1] === '*' ? hi : m[3] != null ? Number(m[3]) : m[4] ? hi : from;
    if (step < 1 || from < lo || to > hi || from > to) throw new Error(`${NAMES[i]}: «${part}» è fuori da ${lo}-${hi}`);
    for (let v = from; v <= to; v += step) values.add(i === 4 && v === 7 ? 0 : v);
  }
  return { values, any: raw === '*' };
}

/** Legge un cron; lancia un errore in italiano se non va. */
export function parseCron(source: string): Cron {
  const parts = source.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Servono 5 campi: minuto ora giorno mese giorno-della-settimana (es. 0 8 * * 1-5)');
  const [minute, hour, day, month, weekday] = parts.map(parseField);
  return { minute, hour, day, month, weekday, source: parts.join(' ') };
}

let fmt: { v: number; f: Intl.DateTimeFormat } | null = null;
const formatter = () => {
  if (fmt?.v !== zoneVersion()) fmt = { v: zoneVersion(), f: new Intl.DateTimeFormat('en-GB', { timeZone: timeZone(), hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }) };
  return fmt.f;
};
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Minuto, ora, giorno, mese e giorno della settimana di un istante, nel fuso di Ciccio. */
export function zoneParts(ms: number) {
  const p: Record<string, string> = {};
  for (const x of formatter().formatToParts(new Date(ms))) p[x.type] = x.value;
  return { minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month), weekday: WD[p.weekday] ?? 0, year: Number(p.year) };
}

function dayMatches(c: Cron, p: ReturnType<typeof zoneParts>): boolean {
  if (!c.month.values.has(p.month)) return false;
  const d = c.day.values.has(p.day), w = c.weekday.values.has(p.weekday);
  if (c.day.any && c.weekday.any) return true;
  if (c.day.any) return w;
  if (c.weekday.any) return d;
  return d || w;
}

/** Il minuto di quell'istante (nel fuso di Ciccio) è uno di quelli del cron. */
export function cronMatches(c: Cron, ms: number): boolean {
  const p = zoneParts(ms);
  return dayMatches(c, p) && c.hour.values.has(p.hour) && c.minute.values.has(p.minute);
}

/**
 * Prossimi istanti (inizio del minuto) dopo `from`, fino a `count` e al massimo un anno avanti.
 * Salta a ore intere dove giorno o ora non vanno: così un anno sono poche migliaia di passi.
 */
export function nextRuns(c: Cron, from: number, count = 1): number[] {
  const out: number[] = [];
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  const end = from + 366 * 86_400_000;
  while (t <= end && out.length < count) {
    const p = zoneParts(t);
    if (!dayMatches(c, p) || !c.hour.values.has(p.hour)) { t += (60 - p.minute) * 60_000; continue; }
    if (c.minute.values.has(p.minute)) out.push(t);
    t += 60_000;
  }
  return out;
}

const DAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const DAYS_SHORT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const pad = (n: number) => String(n).padStart(2, '0');
const single = (f: Field) => (f.values.size === 1 ? [...f.values][0] : null);

/** Il cron in italiano, per le forme che costruisce la pagina; per le altre, il cron così com'è. */
export function describeCron(source: string): string {
  let c: Cron;
  try { c = parseCron(source); } catch { return source; }
  const [m, h, dom, mon, dow] = c.source.split(' ');
  const minute = single(c.minute), hour = single(c.hour);
  const at = minute != null && hour != null ? `alle ${pad(hour)}:${pad(minute)}` : null;
  if (at && dom === '*' && mon === '*') {
    if (dow === '*') return `ogni giorno ${at}`;
    const days = [...c.weekday.values].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    if (dow === '1-5') return `dal lunedì al venerdì ${at}`;
    if (days.length === 1) return `ogni ${DAYS[days[0]]} ${at}`;
    return `${days.map((d) => DAYS_SHORT[d]).join(', ')} ${at}`;
  }
  if (at && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `il ${dom} di ogni mese ${at}`;
  const every = /^\*\/(\d+)$/.exec(h);
  if (minute != null && every && dom === '*' && mon === '*' && dow === '*') return `ogni ${every[1]} ore, al minuto ${minute}`;
  if (minute != null && h === '*' && dom === '*' && mon === '*' && dow === '*') return `ogni ora, al minuto ${minute}`;
  const everyMin = /^\*\/(\d+)$/.exec(m);
  if (everyMin && h === '*' && dom === '*' && mon === '*' && dow === '*') return `ogni ${everyMin[1]} minuti`;
  return `cron ${c.source}`;
}
