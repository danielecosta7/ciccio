/**
 * Vibrazione breve per confermare un gesto (decisione su un permesso, invio, soglia di uno swipe).
 * Solo dove il browser la offre (Android): Safari su iPhone non ha un'API e lì non succede niente.
 */
export function haptic(kind: 'tap' | 'done' | 'warn' = 'tap') {
  try {
    navigator.vibrate?.(kind === 'tap' ? 8 : kind === 'done' ? [10, 40, 12] : 22);
  } catch { /* vibrazione non disponibile */ }
}
