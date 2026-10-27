// Trascrizione del browser (Web Speech): Chrome manda l'audio a Google, Safari ad Apple.
// Si usa solo se scelta nelle Impostazioni › Voce; stessi eventi del microfono con Whisper.

interface Rec {
  lang: string; interimResults: boolean; continuous: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onspeechstart: (() => void) | null;
}

export const browserSttSupported = () => typeof window !== 'undefined'
  && !!((window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);

export class BrowserEar {
  private rec: Rec | null = null;
  private active = false;
  muted = false;
  constructor(private ev: { onSpeechStart?: () => void; onInterim?: (t: string) => void; onFinal?: (t: string) => void; onError?: (msg: string) => void }) {}

  /** Nello stesso tocco del pulsante (iPhone). Si riaccende da solo finché non lo fermi. */
  start() {
    const W = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) throw new Error('Questo browser non ha il riconoscimento vocale: scegli Whisper nelle Impostazioni › Voce.');
    this.active = true;
    const r = new Ctor();
    r.lang = 'it-IT';
    r.interimResults = true;
    r.continuous = true;
    let speaking = false;
    r.onresult = (e) => {
      if (this.muted) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript.trim();
        if (!t) continue;
        if (!speaking) { speaking = true; this.ev.onSpeechStart?.(); }
        if (e.results[i].isFinal) { speaking = false; this.ev.onFinal?.(t); }
        else this.ev.onInterim?.(t);
      }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.active = false; this.ev.onError?.('Il browser non ha il permesso del microfono, o non offre il riconoscimento qui: prova Whisper nelle Impostazioni › Voce.'); }
    };
    r.onend = () => { if (this.active) { try { r.start(); } catch { /* già ripartito */ } } };
    this.rec = r;
    r.start();
  }

  stop() {
    this.active = false;
    try { this.rec?.abort(); } catch { /* già fermo */ }
    this.rec = null;
  }
}
