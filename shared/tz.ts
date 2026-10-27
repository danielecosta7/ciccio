// Fuso orario di Ciccio: giorni dei consumi e del riepilogo, orari delle routine, ore mostrate nella pagina.
// Sul server viene da CICCIO_TZ (di serie quello del sistema), la pagina lo riceve con le impostazioni.
// Finché non lo sa, ognuno usa il suo.

let zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
let version = 0;

export const timeZone = () => zone;

/** Cambia a ogni setTimeZone: chi tiene formattatori o cache li rifà. */
export const zoneVersion = () => version;

/** Fuso valido per Intl (es. Europe/Rome), oppure null. */
export function validZone(tz: string | undefined): string | null {
  if (!tz?.trim()) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).resolvedOptions().timeZone; } catch { return null; }
}

export function setTimeZone(tz: string) {
  const v = validZone(tz);
  if (!v || v === zone) return;
  zone = v;
  version += 1;
}

/** Giorno AAAA-MM-GG di un istante nel fuso di Ciccio. */
export const dayIn = (ms = Date.now()) => new Intl.DateTimeFormat('sv-SE', { timeZone: zone }).format(new Date(ms));
