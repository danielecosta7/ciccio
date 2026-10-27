import type { Transition } from 'motion/react';

/** Curva unica di Ciccio: uscita rapida e morbida (ease-out-quart), niente rimbalzi. */
export const EASE = [0.25, 1, 0.5, 1] as const;
export const quick: Transition = { duration: 0.18, ease: EASE };
export const smooth: Transition = { duration: 0.28, ease: EASE };

/** Pannelli che entrano da destra. */
export const slideRight = {
  initial: { opacity: 0, x: 28 },
  animate: { opacity: 1, x: 0, transition: smooth },
  exit: { opacity: 0, x: 28, transition: quick },
};

/** Finestre che salgono dal basso (chat di Ciccio, avvisi). */
export const rise = {
  initial: { opacity: 0, y: 16, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1, transition: smooth },
  exit: { opacity: 0, y: 12, scale: 0.98, transition: quick },
};

/** Righe nel flusso della pagina (avvisi, errori, stati): si aprono e si chiudono in altezza, senza salti. */
export const collapse = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: 'auto', transition: smooth },
  exit: { opacity: 0, height: 0, transition: quick },
};

/**
 * Pagine del telefono: avanti entra da destra (la pagina sotto arretra un poco), indietro esce a destra.
 * `custom` è la direzione: 1 avanti, -1 indietro, 0 cambio di scheda (solo dissolvenza), -2 indietro con lo swipe
 * dal bordo (la pagina l'ha già portata via il dito: esce subito, senza rifare il movimento).
 */
export const page = {
  initial: (dir: number) => (dir ? { x: dir > 0 ? '100%' : '-24%', opacity: dir > 0 ? 1 : 0.6 } : { opacity: 0 }),
  animate: { x: 0, opacity: 1, transition: smooth },
  exit: (dir: number) => (dir === -2 ? { opacity: 0, transition: { duration: 0 } }
    : dir ? { x: dir > 0 ? '-24%' : '100%', opacity: dir > 0 ? 0.6 : 1, transition: quick } : { opacity: 0, transition: { duration: 0.12 } }),
};

/** Fogli dal basso: salgono con la curva di Ciccio, scendono più in fretta. */
export const sheetIn: Transition = { duration: 0.32, ease: EASE };
export const sheetOut: Transition = { duration: 0.22, ease: EASE };

/** Elementi piccoli che compaiono e spariscono (chip, pulsanti, overlay). */
export const pop = {
  initial: { opacity: 0, scale: 0.92 },
  animate: { opacity: 1, scale: 1, transition: quick },
  exit: { opacity: 0, scale: 0.92, transition: quick },
};
