// Microfono con rilevamento della voce: capisce da solo quando inizi e quando smetti di parlare.
// Audio a 16 kHz in memoria, mai salvato; ogni frase finita va al servizio voce sul server.

const RATE = 16000;
const FRAME = 320; // 20 ms
const PREROLL_FRAMES = 15; // 300 ms prima dell'inizio, per non tagliare la prima sillaba
const START_FRAMES = 4; // 80 ms sopra soglia = inizio
/** Silenzio che chiude un pezzo di frase: corto, perché chi ascolta (la conversazione) decide poi se hai finito davvero. */
const DEFAULT_PAUSE_MS = 700;
const MIN_SPEECH_FRAMES = 20; // sotto i 400 ms è un rumore
const MAX_FRAMES = 60 * 50; // un minuto

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor('ciccio-tap', Tap);
`;

export interface MicEvents {
  onSpeechStart?: () => void;
  onSpeechEnd?: (pcm: Int16Array) => void;
  /** La «voce» era troppo breve: un rumore, scartato. */
  onNoise?: () => void;
  onLevel?: (level: number) => void;
}

export class Mic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private pending: number[] = [];
  private frames: Int16Array[] = [];
  private preroll: Int16Array[] = [];
  private above = 0;
  private below = 0;
  private speaking = false;
  private noise = 0.004;
  muted = false;
  /** Mentre Ciccio parla serve una voce più decisa per interromperlo (niente eco scambiata per te). */
  strict = false;
  /** Sensibilità dalle Impostazioni: alta sente anche la voce bassa, bassa ignora i rumori di fondo. */
  sensitivity: 'bassa' | 'media' | 'alta' = 'media';
  /** Silenzio (ms) dopo cui il pezzo di frase si chiude e va trascritto. */
  pauseMs = DEFAULT_PAUSE_MS;
  /** Filtro passa-basso prima di scendere a 16 kHz: senza, le frequenze alte si ripiegavano nella voce (meno precisione). */
  private lp: LowPass | null = null;
  /** Vocale: tutto l'audio da quando parte, pause comprese (non solo le frasi); null se non si registra. */
  private tape: Int16Array[] | null = null;

  constructor(private ev: MicEvents) {}

  get active() { return !!this.stream; }

  /**
   * Va chiamato nello stesso tocco del pulsante, prima di ogni attesa: su iPhone l'audio nato dopo
   * un'attesa resta in pausa e arriva solo silenzio. Frequenza nativa, si ricampiona qui a 16 kHz.
   */
  async start() {
    this.ctx = new AudioContext();
    const resumed = this.ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    // Su telefono il tocco che tiene premuto non sempre basta a far partire l'audio: si riprova a microfono aperto.
    await resumed.catch(() => undefined);
    if (this.ctx.state !== 'running') await this.ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'ciccio-tap');
    const ratio = this.ctx.sampleRate / RATE;
    this.lp = ratio > 1 ? new LowPass(this.ctx.sampleRate, 7000) : null;
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.push(e.data, ratio);
    src.connect(this.node);
  }

  stop() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null; this.stream = null; this.node = null;
    this.reset();
  }

  /** Da qui in poi tiene tutto l'audio, per un vocale. */
  record() { this.tape = []; }

  /** Audio registrato da `record()` (16 kHz). */
  recorded(): Int16Array { return join(this.tape ?? []); }

  /** Audio della frase in corso (per la trascrizione dal vivo). */
  current(): Int16Array | null {
    if (!this.speaking || !this.frames.length) return null;
    return join(this.frames);
  }

  private reset() {
    this.frames = []; this.preroll = []; this.pending = []; this.carry = []; this.phase = 0;
    this.above = 0; this.below = 0; this.speaking = false;
  }

  /** Campioni avanzati dal blocco precedente: il ricampionamento continua senza salti tra un blocco e l'altro. */
  private carry: number[] = [];
  private phase = 0;

  private push(chunk: Float32Array, ratio: number) {
    if (ratio === 1) for (let i = 0; i < chunk.length; i++) this.pending.push(chunk[i]);
    else {
      // Da 44,1/48 kHz a 16 kHz: filtro sotto gli 8 kHz, poi un campione ogni `ratio` (interpolato).
      const filtered = this.lp ? this.lp.run(chunk) : chunk;
      const data = this.carry.length ? [...this.carry, ...filtered] : Array.from(filtered);
      // `phase`: dove cade il prossimo campione nel blocco, così da un blocco all'altro il passo resta esatto.
      let i = this.phase;
      while (i + 1 < data.length) {
        const a = Math.floor(i), f = i - a;
        this.pending.push(data[a] * (1 - f) + data[a + 1] * f);
        i += ratio;
      }
      this.carry = data.slice(Math.floor(i));
      this.phase = i - Math.floor(i);
    }
    while (this.pending.length >= FRAME) this.frame(this.pending.splice(0, FRAME));
  }

  private frame(samples: number[]) {
    let sum = 0;
    const pcm = new Int16Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      sum += v * v;
      pcm[i] = v * 32767;
    }
    const rms = Math.sqrt(sum / FRAME);
    this.ev.onLevel?.(Math.min(1, rms * 12));
    if (this.tape && !this.muted) this.tape.push(pcm);
    if (this.muted) { if (this.speaking) this.reset(); return; }

    const k = this.sensitivity === 'alta' ? 0.7 : this.sensitivity === 'bassa' ? 1.5 : 1;
    // Mentre Ciccio parla serve un po' più di voce (l'eco che passa il filtro del browser non deve interromperlo),
    // ma non troppa: il filtro dell'eco abbassa anche la tua voce, e prima non riuscivi a fermarlo.
    const startAt = Math.max(this.noise * (this.strict ? 4 : 3) * k, (this.strict ? 0.02 : 0.012) * k);
    const endAt = Math.max(this.noise * 2, 0.008 * Math.min(k, 1.2));
    if (!this.speaking) {
      // Il rumore di fondo si aggiorna piano, solo quando non parli.
      this.noise = this.noise * 0.97 + rms * 0.03;
      this.preroll.push(pcm);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      this.above = rms > startAt ? this.above + 1 : 0;
      if (this.above >= START_FRAMES) {
        this.speaking = true;
        this.frames = [...this.preroll];
        this.below = 0;
        this.ev.onSpeechStart?.();
      }
      return;
    }
    this.frames.push(pcm);
    this.below = rms < endAt ? this.below + 1 : 0;
    if (this.below >= Math.round(this.pauseMs / 20) || this.frames.length >= MAX_FRAMES) {
      const voiced = this.frames.length - this.below;
      const audio = join(this.frames);
      this.reset();
      if (voiced >= MIN_SPEECH_FRAMES) this.ev.onSpeechEnd?.(audio);
      else this.ev.onNoise?.();
    }
  }
}

/** Passa-basso Butterworth del quarto ordine (due biquad in fila), coefficienti RBJ. */
class LowPass {
  private st = [[0, 0, 0, 0], [0, 0, 0, 0]];
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number;
  constructor(rate: number, cutoff: number) {
    const w = (2 * Math.PI * cutoff) / rate;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cos) / 2) / a0; this.b1 = (1 - cos) / a0; this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0; this.a2 = (1 - alpha) / a0;
  }
  run(input: Float32Array): Float32Array {
    const out = new Float32Array(input.length);
    out.set(input);
    for (const s of this.st) {
      for (let i = 0; i < out.length; i++) {
        const x = out[i];
        const y = this.b0 * x + this.b1 * s[0] + this.b2 * s[1] - this.a1 * s[2] - this.a2 * s[3];
        s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y;
        out[i] = y;
      }
    }
    return out;
  }
}

function join(frames: Int16Array[]): Int16Array {
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) { out.set(f, o); o += f.length; }
  return out;
}
