import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Mic } from './mic';
import { Speaker, sentences, speakable } from './speaker';
import { transcribe } from './wav';
import { BrowserEar } from './browserStt';

/** Servizi vocali scelti nelle Impostazioni › Voce (la voce del dispositivo è salvata su ogni dispositivo). */
export interface VoicePrefs {
  stt?: AppSettings['sttEngine'];
  tts?: AppSettings['ttsEngine'];
  speed?: 'lenta' | 'normale' | 'veloce';
  sensitivity?: 'bassa' | 'media' | 'alta';
}

/** Servizi vocali correnti: li aggiorna App dalle Impostazioni, li leggono dettatura e pulsanti di prova. */
let currentPrefs: VoicePrefs = {};
export const setVoicePrefs = (p: VoicePrefs) => { currentPrefs = p; };
export const getVoicePrefs = () => currentPrefs;

export const deviceVoiceName = () => { try { return localStorage.getItem('ciccio.deviceVoice') ?? ''; } catch { return ''; } };

/** Prepara chi parla secondo le Impostazioni. */
export function configureSpeaker(sp: Speaker, prefs: VoicePrefs) {
  sp.engine = prefs.tts === 'device' ? 'device' : 'server';
  sp.deviceVoice = deviceVoiceName();
  sp.speed = prefs.speed ?? 'normale';
}
import type { AppSettings, ChatMessage, LiveState } from '../../../shared/types';

const PARTIAL_MS = 1100;

export type ConvState = 'off' | 'starting' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking';

/**
 * Hai finito di parlare? Dopo una pausa breve il pezzo di frase si trascrive subito; poi si aspetta ancora un
 * poco, di più se la frase resta sospesa («…e», «…perché», «allora…»): le pause per pensare non la spezzano.
 */
const GRACE_MS = 650;
/** Tetto delle parole dette per risposta. */
const SPOKEN_WORDS = 60;
const GRACE_OPEN_MS = 1900;
const OPEN_END = /(\b(e|ed|o|ma|però|perché|che|chi|cui|quindi|poi|allora|cioè|tipo|se|quando|come|dove|di|da|a|in|con|per|su|tra|fra|il|lo|la|i|gli|le|un|uno|una|del|della|dei|delle|al|alla|nel|nella|sul|sulla|mio|mia|tuo|tua|questo|questa|quello|quella|anche|ancora|più|meno|non|ehm|uhm|eh|mh|cosa|tipo)|,|\.\.\.|…)\s*$/i;

/** Mentre Ciccio lavora, una frase per non lasciarti nel silenzio (una per giro, più una se ci mette tanto). */
function fillerFor(tool?: string): string {
  const t = tool ?? '';
  if (/agenti|novita|chat_agente|status_md|permessi/.test(t)) return 'Un attimo, guardo gli agenti.';
  if (/WebSearch|WebFetch/.test(t)) return 'Cerco un attimo.';
  if (/scrivi_ad_agente/.test(t)) return 'Glielo passo.';
  if (/gmail|mail|calendar|calendario|outlook/i.test(t)) return 'Controllo un attimo.';
  return 'Un attimo.';
}

/** Parole in comune con quello che Ciccio ha appena detto: oltre metà = è la sua voce risentita dal microfono. */
function looksLikeEcho(text: string, recent: string[]): boolean {
  const words = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2);
  const mine = words(text);
  if (mine.length < 2) return false;
  const said = new Set(recent.flatMap(words));
  return mine.filter((w) => said.has(w)).length / mine.length > 0.6;
}

/**
 * Conversazione a mani libere con Ciccio, come al telefono:
 * - ti ascolta sempre; una pausa breve non chiude la frase, i pezzi si uniscono e partono insieme;
 * - Ciccio risponde frase per frase mentre scrive e, se deve controllare qualcosa, te lo dice;
 * - se parli mentre risponde abbassa la voce; se era davvero una frase tua si ferma e ti ascolta
 *   (anche il suo giro si ferma), se era un rumore o la sua eco riprende.
 */
export function useConversation(opts: { thread: ChatMessage[]; live?: LiveState; running: boolean; replies?: boolean } & VoicePrefs) {
  const [state, setState] = useState<ConvState>('off');
  const [interim, setInterim] = useState('');
  const [said, setSaid] = useState('');
  const [reply, setReply] = useState('');
  const [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');

  const mic = useRef<Mic | null>(null);
  const ear = useRef<BrowserEar | null>(null);
  const speaker = useRef<Speaker | null>(null);
  const partialBusy = useRef(false);
  const partialTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  /** Pezzi della frase in corso già trascritti, trascrizioni ancora in volo e attesa prima di mandarla. */
  const pieces = useRef<string[]>([]);
  const inFlight = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const grace = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Hai cominciato a parlare sopra Ciccio: la sua voce è abbassata finché non si capisce cos'era. */
  const bargeIn = useRef(false);
  /** Da quando contano le risposte di Ciccio, quanto testo è già stato messo in coda da dire, frasi di attesa dette. */
  const replyFrom = useRef(0);
  const spoken = useRef(0);
  const fillers = useRef(0);
  /** Parole già dette in questo giro: oltre un tetto Ciccio chiude e lascia il resto scritto. */
  const words = useRef(0);
  const sentAt = useRef(0);
  const waiting = useRef(false);
  const stateRef = useRef<ConvState>('off');
  const repliesRef = useRef(opts.replies !== false);
  repliesRef.current = opts.replies !== false;
  const runningRef = useRef(opts.running);
  runningRef.current = opts.running;
  // Livello del microfono: aggiornato al massimo 15 volte al secondo; quando hai parlato forte l'ultima volta.
  const levelAt = useRef(0);
  const startedAt = useRef(0);
  const loudAt = useRef(0);
  const [silent, setSilent] = useState(false);
  const onLevel = useCallback((l: number) => {
    const now = Date.now();
    if (l > 0.08) loudAt.current = now;
    if (now - levelAt.current > 66) { levelAt.current = now; setLevel(l); }
  }, []);
  // Dopo 5 secondi di silenzio totale dall'accensione: probabilmente il microfono non arriva.
  useEffect(() => {
    const t = setInterval(() => {
      const on = stateRef.current === 'listening' && startedAt.current > 0 && !loudAt.current && Date.now() - startedAt.current > 5000;
      setSilent(on);
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const set = (s: ConvState) => { stateRef.current = s; setState(s); };
  const idle = () => set(waiting.current ? 'thinking' : speaker.current?.busy ? 'speaking' : 'listening');

  const stopPartials = () => { clearInterval(partialTimer.current); partialTimer.current = undefined; };

  const say = useCallback((text: string) => { if (repliesRef.current) speaker.current?.say(text); }, []);

  /** Frase finita: va a Ciccio come messaggio detto a voce. Se Ciccio stava ancora lavorando, prima si ferma. */
  const sendText = useCallback(async (text: string) => {
    try {
      if (!text || text.replace(/[^\p{L}\p{N}]/gu, '').length < 2) { idle(); return; }
      if (speaker.current?.busy) speaker.current.stop();
      if (runningRef.current || waiting.current) await api.ciccioStop().catch(() => undefined);
      setSaid(text);
      setInterim('');
      setReply('');
      replyFrom.current = Date.now() - 500;
      spoken.current = 0;
      fillers.current = 0;
      words.current = 0;
      sentAt.current = Date.now();
      waiting.current = true;
      set('thinking');
      await api.ciccio(text, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      waiting.current = false;
      set('listening');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Tutto trascritto e nessuna voce da un po': si decide cosa fare della frase. */
  const settle = useCallback(() => {
    clearTimeout(grace.current);
    if (inFlight.current > 0 || mic.current?.current()) return;
    const text = pieces.current.join(' ').replace(/\s+/g, ' ').trim();
    const wait = OPEN_END.test(text) ? GRACE_OPEN_MS : GRACE_MS;
    grace.current = setTimeout(() => {
      if (inFlight.current > 0 || mic.current?.current()) return;
      pieces.current = [];
      const wasBargeIn = bargeIn.current;
      bargeIn.current = false;
      // Rumore, tosse, o Ciccio che si risente dal microfono: la sua voce torna normale e si continua.
      if (!text || (wasBargeIn && looksLikeEcho(text, speaker.current?.recent ?? []))) {
        speaker.current?.duck(false);
        setInterim('');
        idle();
        return;
      }
      void sendText(text);
    }, wait);
  }, [sendText]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSpeechStart = useCallback(() => {
    clearTimeout(grace.current);
    // Parli sopra Ciccio: abbassa la voce, si ferma solo se è davvero una frase tua.
    if (speaker.current?.busy) { bargeIn.current = true; speaker.current.duck(true); }
    set('hearing');
    stopPartials();
    partialTimer.current = setInterval(() => {
      const pcm = mic.current?.current();
      if (!pcm || pcm.length < 16000 * 0.7 || partialBusy.current) return;
      partialBusy.current = true;
      void transcribe(pcm, true).then((t) => {
        if (stateRef.current === 'hearing') setInterim([...pieces.current, t].join(' ').trim());
      }).catch(() => undefined).finally(() => { partialBusy.current = false; });
    }, PARTIAL_MS);
  }, []);

  /** Pezzo di frase finito (pausa breve): si trascrive subito, nell'ordine, mentre si aspetta di capire se continui. */
  const onSpeechEnd = useCallback((pcm: Int16Array) => {
    stopPartials();
    inFlight.current += 1;
    if (stateRef.current === 'hearing') set('transcribing');
    chain.current = chain.current.then(async () => {
      try {
        const t = await transcribe(pcm);
        if (t) { pieces.current.push(t); setInterim(pieces.current.join(' ')); }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight.current -= 1;
        if (stateRef.current === 'transcribing' && inFlight.current === 0 && !mic.current?.current()) set(pieces.current.length ? 'transcribing' : bargeIn.current ? 'speaking' : 'listening');
        settle();
      }
    });
  }, [settle]);

  /** Un rumore breve: se aveva messo in pausa Ciccio e non c'è altro da trascrivere, Ciccio riprende. */
  const onNoise = useCallback(() => {
    stopPartials();
    if (inFlight.current > 0 || pieces.current.length) { settle(); return; }
    if (bargeIn.current) { bargeIn.current = false; speaker.current?.duck(false); }
    idle();
  }, [settle]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(async () => {
    setError(''); setSaid(''); setReply(''); setInterim('');
    pieces.current = []; bargeIn.current = false;
    set('starting');
    speaker.current ??= new Speaker();
    configureSpeaker(speaker.current, opts);
    speaker.current.unlock();
    speaker.current.onProblem = (m) => setError(m);
    speaker.current.onState = (on) => {
      if (mic.current) mic.current.strict = on;
      // Con la trascrizione del browser niente ascolto mentre Ciccio parla: si sentirebbe da solo.
      if (ear.current) ear.current.muted = on;
      if (on) { if (stateRef.current === 'listening' || stateRef.current === 'thinking') set('speaking'); }
      else if (stateRef.current === 'speaking') idle();
    };
    if (opts.stt === 'browser') {
      // Riconoscimento del browser: testo provvisorio mentre parli, frase finita quando fai una pausa.
      try {
        ear.current = new BrowserEar({
          onSpeechStart: () => { if (speaker.current?.busy) speaker.current.stop(); set('hearing'); },
          onInterim: (t) => { setInterim(t); setLevel(0.45 + Math.random() * 0.3); },
          onFinal: (t) => { setLevel(0); setInterim(''); void sendText(t); },
          onError: (m) => { setError(m); set('off'); },
        });
        ear.current.start();
        set('listening');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        ear.current = null;
        set('off');
      }
      return;
    }
    // Il microfono parte subito, nel tocco stesso (iPhone); il controllo del server va in parallelo.
    mic.current = new Mic({ onSpeechStart, onSpeechEnd, onNoise, onLevel });
    mic.current.sensitivity = opts.sensitivity ?? 'media';
    const micReady = mic.current.start();
    micReady.catch(() => undefined); // l'errore lo gestisce il try qui sotto
    try {
      const health = await (await fetch('/api/voice/health')).json() as { ok: boolean };
      if (!health.ok) throw new Error('Il servizio voce sul server non risponde.');
      await micReady;
      startedAt.current = Date.now();
      loudAt.current = 0;
      set('listening');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/denied|NotAllowed|Permission/i.test(msg) ? 'Serve il permesso per il microfono: concedilo nelle impostazioni del browser.' : msg);
      mic.current?.stop(); mic.current = null;
      set('off');
    }
  }, [onSpeechStart, onSpeechEnd, onNoise, sendText, opts.sensitivity, opts.stt, opts.tts, opts.speed]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = useCallback(() => {
    stopPartials();
    clearTimeout(grace.current);
    pieces.current = [];
    bargeIn.current = false;
    mic.current?.stop(); mic.current = null;
    ear.current?.stop(); ear.current = null;
    speaker.current?.stop();
    waiting.current = false;
    startedAt.current = 0;
    setSilent(false);
    setLevel(0);
    set('off');
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => { const next = !m; if (mic.current) mic.current.muted = next; if (ear.current) ear.current.muted = next; return next; });
  }, []);

  // Mentre Ciccio lavora senza aver ancora detto niente: dopo un po' una frase di attesa, poi un'altra se ci mette tanto.
  useEffect(() => {
    const t = setInterval(() => {
      if (!waiting.current || spoken.current > 0 || speaker.current?.busy || stateRef.current !== 'thinking') return;
      const since = Date.now() - sentAt.current;
      if ((fillers.current === 0 && since > 2500) || (fillers.current === 1 && since > 15000)) {
        say(fillers.current === 0 ? fillerFor(opts.live?.tool) : 'Ci sto ancora lavorando, un momento.');
        fillers.current += 1;
      }
    }, 500);
    return () => clearInterval(t);
  }, [opts.live?.tool, say]);

  // La risposta di Ciccio mentre la scrive: messaggi salvati dopo la tua frase più il testo in diretta.
  // Gli avvisi degli agenti arrivati nel frattempo restano scritti in chat, non si leggono.
  useEffect(() => {
    if (stateRef.current === 'off' || !waiting.current) return;
    const saved = opts.thread.filter((m) => (m.role === 'agent' || m.role === 'ciccio') && m.meta?.kind !== 'notice' && m.ts >= replyFrom.current).map((m) => m.text);
    const liveText = opts.live?.phase === 'writing' ? opts.live.text : '';
    const full = [...saved, liveText].filter(Boolean).join('\n');
    setReply(full);
    const clean = speakable(full);
    // Si dice solo la parte nuova e solo frasi complete; l'ultima appena finisce con un punto, a fine risposta comunque.
    const rest = clean.slice(spoken.current);
    const parts = sentences(rest);
    const done = !opts.running;
    const lastClosed = parts.length > 0 && /[.!?…]$/.test(parts[parts.length - 1]) && /[.!?…]\s*$/.test(rest);
    const ready = done || lastClosed ? parts : parts.slice(0, -1);
    if (ready.length && !muted) {
      const chunk = ready.join(' ');
      const idx = rest.indexOf(ready[ready.length - 1]) + ready[ready.length - 1].length;
      spoken.current += idx > 0 ? idx : chunk.length;
      // A voce al massimo una sessantina di parole: il resto resta scritto in chat (la pazienza finisce prima).
      if (words.current < SPOKEN_WORDS) {
        const n = chunk.split(/\s+/).length;
        if (words.current > 0 && words.current + n > SPOKEN_WORDS + 15) { say('Il resto te l\'ho lasciato scritto.'); words.current = SPOKEN_WORDS; }
        else { say(chunk); words.current += n; if (words.current >= SPOKEN_WORDS && !done) { say('Il resto te l\'ho lasciato scritto.'); } }
      }
    }
    if (done && saved.length) {
      waiting.current = false;
      if (!speaker.current?.busy && stateRef.current === 'thinking') set('listening');
    }
  }, [opts.thread, opts.live, opts.running, muted, say]);

  useEffect(() => () => { stopPartials(); clearTimeout(grace.current); mic.current?.stop(); ear.current?.stop(); speaker.current?.close(); }, []);

  return { state, interim, said, reply, level, muted, error, silent, start, stop, toggleMute };
}

/**
 * Dettatura in un campo di testo, continua: resta accesa finché non la fermi (anche per minuti),
 * ogni frase finita si aggiunge al testo nell'ordine giusto e le pause non la chiudono.
 * Si spegne da sola solo dopo 5 minuti di silenzio, per non lasciare il microfono acceso.
 */
const DICTATION_IDLE_MS = 5 * 60_000;

export function useDictation(onText: (text: string) => void, stt?: VoicePrefs['stt']) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const mic = useRef<Mic | null>(null);
  const ear = useRef<BrowserEar | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = useRef(false);
  // Le frasi si trascrivono una dopo l'altra: il testo arriva nell'ordine in cui le hai dette.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const textRef = useRef(onText);
  textRef.current = onText;

  const queue = useCallback((pcm: Int16Array) => {
    setInterim('…');
    chain.current = chain.current.then(async () => {
      try { const t = await transcribe(pcm); if (t) textRef.current(t); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }).finally(() => { if (!mic.current?.current()) setInterim(''); });
  }, []);

  const stop = useCallback(() => {
    clearInterval(timer.current);
    clearTimeout(idle.current);
    // La frase che stavi dicendo quando hai premuto stop non va persa.
    const last = mic.current?.current();
    if (last && last.length > 16000 * 0.4) queue(last);
    mic.current?.stop(); mic.current = null;
    ear.current?.stop(); ear.current = null;
    setListening(false);
    if (!last) setInterim('');
  }, [queue]);

  const resetIdle = useCallback(() => {
    clearTimeout(idle.current);
    idle.current = setTimeout(() => stop(), DICTATION_IDLE_MS);
  }, [stop]);

  const start = useCallback(async () => {
    setError('');
    if ((stt ?? currentPrefs.stt) === 'browser') {
      try {
        ear.current = new BrowserEar({
          onInterim: (t) => { setInterim(t); resetIdle(); },
          onFinal: (t) => { textRef.current(t); setInterim(''); resetIdle(); },
          onError: (m) => { setError(m); stop(); },
        });
        ear.current.start();
        setListening(true);
        resetIdle();
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); stop(); }
      return;
    }
    try {
      mic.current = new Mic({
        onSpeechStart: () => {
          resetIdle();
          clearInterval(timer.current);
          timer.current = setInterval(() => {
            const pcm = mic.current?.current();
            if (!pcm || pcm.length < 16000 * 0.7 || busy.current) return;
            busy.current = true;
            void transcribe(pcm, true).then((t) => { if (t) setInterim(t); }).catch(() => undefined).finally(() => { busy.current = false; });
          }, PARTIAL_MS);
        },
        onSpeechEnd: (pcm) => {
          clearInterval(timer.current);
          resetIdle();
          queue(pcm);
        },
      });
      mic.current.sensitivity = currentPrefs.sensitivity ?? 'media';
      await mic.current.start();
      setListening(true);
      resetIdle();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/denied|NotAllowed|Permission/i.test(msg) ? 'Serve il permesso per il microfono.' : msg);
      stop();
    }
  }, [stop, stt, queue, resetIdle]);

  useEffect(() => () => { clearInterval(timer.current); clearTimeout(idle.current); mic.current?.stop(); ear.current?.stop(); }, []);

  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  return { supported, listening, interim, error, start, stop };
}
