// Voce di Ciccio: frasi sintetizzate sul server (Piper) e suonate in fila, la prossima già pronta
// mentre suona questa. stop() zittisce subito (quando lo interrompi parlando).

export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (ti ho scritto del codice in chat) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/https?:\/\/\S+/g, 'un link')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Spezza in frasi da dire: punto, domanda, esclamazione, a capo; le frasi lunghe alla virgola. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/(?<=[.!?…:;])\s+|\n+/)) {
    let s = raw.trim();
    while (s.length > 220) {
      const cut = s.lastIndexOf(',', 200);
      const at = cut > 60 ? cut + 1 : 200;
      out.push(s.slice(0, at).trim());
      s = s.slice(at).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

const RATE: Record<string, number> = { lenta: 0.9, normale: 1.02, veloce: 1.15 };

/** Voci italiane del dispositivo (per la scelta nelle Impostazioni). */
export function deviceVoices(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return [];
  return speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('it'));
}

export class Speaker {
  /** "device": voce del sistema (locale), altrimenti Piper sul server. */
  engine: 'server' | 'device' = 'server';
  deviceVoice = '';
  speed: 'lenta' | 'normale' | 'veloce' = 'normale';
  private deviceQueue = 0;
  private ctx: AudioContext | null = null;
  private queue: Promise<AudioBuffer | null>[] = [];
  private source: AudioBufferSourceNode | null = null;
  private playing = false;
  private generation = 0;
  private gain: GainNode | null = null;
  /** Ultime frasi dette: se il microfono le risente, è l'eco di Ciccio e non l'utente. */
  recent: string[] = [];
  onState?: (speaking: boolean) => void;
  /** Problema con la voce (servizio esterno che non va, sintesi fallita): una volta per motivo. */
  onProblem?: (message: string) => void;
  private told = new Set<string>();

  /** Va chiamato da un tocco (iOS sblocca l'audio solo così). */
  unlock() {
    this.ctx ??= new AudioContext();
    if (!this.gain) { this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination); }
    void this.ctx.resume();
    // iPhone sblocca anche la voce del sistema solo dentro un tocco.
    if (this.engine === 'device' && typeof speechSynthesis !== 'undefined') speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  }

  get busy() { return this.playing || this.queue.length > 0 || this.deviceQueue > 0; }

  say(text: string) {
    const clean = speakable(text);
    if (!clean) return;
    this.recent = [...this.recent, clean].slice(-4);
    if (this.engine === 'device') { this.sayOnDevice(sentences(clean)); return; }
    for (const s of sentences(clean)) this.queue.push(this.fetchAudio(s, this.generation));
    if (!this.playing) void this.next();
  }

  /** Voce del dispositivo: le frasi vanno in coda al sintetizzatore del sistema, niente rete. */
  private sayOnDevice(parts: string[]) {
    if (typeof speechSynthesis === 'undefined') return;
    const voice = deviceVoices().find((v) => v.name === this.deviceVoice) ?? deviceVoices()[0];
    const gen = this.generation;
    for (const p of parts) {
      const u = new SpeechSynthesisUtterance(p);
      u.lang = 'it-IT';
      if (voice) u.voice = voice;
      u.rate = RATE[this.speed] ?? 1;
      this.deviceQueue += 1;
      u.onstart = () => { if (gen === this.generation && !this.playing) { this.playing = true; this.onState?.(true); } };
      const done = () => {
        if (gen !== this.generation) return;
        this.deviceQueue = Math.max(0, this.deviceQueue - 1);
        if (this.deviceQueue === 0 && this.playing) { this.playing = false; this.onState?.(false); }
      };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    }
  }

  /**
   * Hai cominciato a parlare: Ciccio si mette subito in pausa, a metà parola, finché non si capisce se era
   * davvero una frase tua (poi stop()) o un rumore, o la sua eco (duck(false): riprende da dove era).
   */
  duck(on: boolean) {
    if (this.deviceQueue > 0 && typeof speechSynthesis !== 'undefined') { if (on) speechSynthesis.pause(); else speechSynthesis.resume(); }
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(on ? 0 : 1, this.ctx.currentTime, 0.015);
    if (this.ctx) { if (on) void this.ctx.suspend(); else void this.ctx.resume(); }
  }

  stop() {
    this.generation += 1;
    this.duck(false);
    if (this.deviceQueue > 0 && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.deviceQueue = 0;
    this.queue = [];
    try { this.source?.stop(); } catch { /* già fermo */ }
    this.source = null;
    if (this.playing) { this.playing = false; this.onState?.(false); }
  }

  close() { this.stop(); void this.ctx?.close(); this.ctx = null; this.gain = null; }

  private problem(message: string) {
    if (this.told.has(message)) return;
    this.told.add(message);
    this.onProblem?.(message);
  }

  private async fetchAudio(text: string, gen: number): Promise<AudioBuffer | null> {
    try {
      const res = await fetch('/api/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      const notice = res.headers.get('X-Ciccio-Tts-Notice');
      if (notice) this.problem(decodeURIComponent(notice));
      if (!res.ok) { this.problem((await res.json().catch(() => ({}))).error ?? `La voce non risponde (errore ${res.status}).`); return null; }
      if (gen !== this.generation || !this.ctx) return null;
      return await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch { this.problem('La voce non risponde: controlla la connessione.'); return null; }
  }

  private async next() {
    const gen = this.generation;
    const item = this.queue.shift();
    if (!item) { if (this.playing) { this.playing = false; this.onState?.(false); } return; }
    if (!this.playing) { this.playing = true; this.onState?.(true); }
    const buf = await item;
    if (gen !== this.generation) return;
    if (!buf || !this.ctx) { void this.next(); return; }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain ?? this.ctx.destination);
    src.onended = () => { if (gen === this.generation) void this.next(); };
    this.source = src;
    src.start();
  }
}
