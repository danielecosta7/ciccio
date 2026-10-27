// Servizio voce del server (voice/service.py, Whisper e Piper): è facoltativo, quindi si guarda se risponde.
// All'avvio e poi ogni minuto; quando cambia, chi l'ha chiesto ripubblica le impostazioni (settings.ts sceglie
// browser e dispositivo finché è spento).

const VOICE_URL = process.env.CICCIO_VOICE_URL ?? 'http://127.0.0.1:8791';

/** null finché non si è controllato la prima volta. */
let up: boolean | null = null;

export const voiceUp = () => up;

/** Chiede /health al servizio voce e tiene il risultato. */
export async function checkVoice(): Promise<boolean> {
  let ok = false;
  try { ok = (await fetch(`${VOICE_URL}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* spento */ }
  up = ok;
  return ok;
}

export async function startVoiceHealth(onChange: () => void) {
  await checkVoice();
  setInterval(() => {
    const before = up;
    void checkVoice().then((ok) => { if (ok !== before) onChange(); });
  }, 60_000).unref();
}
