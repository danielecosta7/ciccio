"""Servizio voce di Ciccio: trascrizione (faster-whisper) e sintesi (Piper), tutto sul server.

Ascolta solo su 127.0.0.1: lo chiama il server di Ciccio, che controlla l'accesso.
Nessun audio esce dal server e nessun audio viene salvato su disco.

  POST /stt?partial=1   corpo: WAV mono 16 kHz, 16 bit  ->  {"text": "..."}
  POST /tts             corpo: {"text": "..."}           ->  audio/wav
  GET  /health                                           ->  {"ok": true}
"""

import io
import json
import os
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
from faster_whisper import WhisperModel
from piper import PiperVoice

HOST = os.environ.get("CICCIO_VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("CICCIO_VOICE_PORT", "8791"))
MODELS = os.environ.get("CICCIO_VOICE_MODELS", os.path.expanduser("~/.ciccio/voice-models"))
LANG = os.environ.get("CICCIO_VOICE_LANG", "it")
THREADS = int(os.environ.get("CICCIO_VOICE_THREADS", "4"))
# "base": sul VPS (4 core) trascrive 5 s di parlato in ~2 s, ed è risultato più preciso di "small" in italiano.
WHISPER = os.environ.get("CICCIO_VOICE_WHISPER", "whisper-base")
MAX_AUDIO_SECONDS = 120

# Modelli e voci si scelgono a ogni richiesta (Impostazioni › Voce) e si caricano alla prima volta che servono.
WHISPERS = {"whisper-base", "whisper-small"}
VOICES = {"paola": "it_IT-paola-medium.onnx", "riccardo": "it_IT-riccardo-x_low.onnx"}
_whisper: dict = {}
_voices: dict = {}
_load_lock = threading.Lock()
# Una trascrizione alla volta. La frase finale ha la precedenza: con una finale in attesa i parziali
# rinunciano subito invece di occupare la CPU (prima la finale aspettava dietro di loro).
stt_lock = threading.Lock()
_finals_waiting = 0
_finals_lock = threading.Lock()
# Il testo provvisorio guarda solo gli ultimi secondi: così resta veloce anche a frase lunga.
PARTIAL_SECONDS = 8

# Frasi che Whisper inventa su silenzio, respiri e rumori (sottotitoli dei video su cui è stato addestrato).
HALLUCINATIONS = {
    "grazie", "grazie.", "grazie a tutti", "grazie a tutti.", "grazie per la visione", "grazie per l'attenzione",
    "ciao", "ciao.", "buongiorno", "...", "…", "sottotitoli creati dalla comunità amara.org",
    "sottotitoli e revisione a cura di qtss", "iscriviti al canale", "musica", "[musica]", "(musica)",
}
tts_lock = threading.Lock()


def whisper_model(name: str):
    name = name if name in WHISPERS else WHISPER
    with _load_lock:
        if name not in _whisper:
            t = time.time()
            _whisper[name] = WhisperModel(os.path.join(MODELS, name), device="cpu", compute_type="int8", cpu_threads=THREADS)
            print(f"caricato {name} in {time.time() - t:.1f}s", flush=True)
        return _whisper[name]


def piper_voice(name: str):
    name = name if name in VOICES else "paola"
    with _load_lock:
        if name not in _voices:
            _voices[name] = PiperVoice.load(os.path.join(MODELS, "piper", VOICES[name]))
            print(f"caricata la voce {name}", flush=True)
        return _voices[name]


print(f"Modelli in {MODELS}: preparo {WHISPER} e paola…", flush=True)
whisper_model(WHISPER)
piper_voice("paola")
print("Modelli pronti.", flush=True)


def read_wav(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != 16000:
            raise ValueError("serve un WAV mono, 16 kHz, 16 bit")
        frames = w.readframes(min(w.getnframes(), 16000 * MAX_AUDIO_SECONDS))
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe(audio: np.ndarray, partial: bool, model: str = WHISPER, prompt: str = "") -> str:
    global _finals_waiting
    m = whisper_model(model)
    if partial:
        audio = audio[-16000 * PARTIAL_SECONDS:]
        if _finals_waiting:
            return ""
    else:
        with _finals_lock:
            _finals_waiting += 1
    try:
        with stt_lock:
            if partial and _finals_waiting:
                return ""
            segments, _ = m.transcribe(
                audio,
                language=LANG,
                beam_size=1 if partial else 5,
                # Nomi di progetti, agenti e termini che l'utente usa: Whisper li scrive giusti invece di storpiarli.
                initial_prompt=prompt or None,
                # La voce la ritaglia già la pagina; il filtro di Whisper toglie i silenzi interni, dove nascono le frasi inventate.
                vad_filter=not partial,
                vad_parameters={"min_silence_duration_ms": 500},
                condition_on_previous_text=False,
                without_timestamps=True,
                no_speech_threshold=0.6,
                log_prob_threshold=-1.0,
                compression_ratio_threshold=2.4,
                temperature=[0.0, 0.2, 0.4],
            )
            kept = []
            for s in segments:
                text = s.text.strip()
                # Segmenti quasi certamente senza voce o inventati: fuori.
                if not text or (s.no_speech_prob > 0.6 and s.avg_logprob < -0.8) or s.avg_logprob < -1.3:
                    continue
                kept.append(text)
            text = " ".join(kept).strip()
            # Il dizionario dei nomi a volte viene ripetuto tale e quale su un audio vuoto.
            if prompt and len(text) > 15 and text.lower().rstrip(".") in prompt.lower():
                return ""
            if text.lower().strip() in HALLUCINATIONS:
                return ""
            return text
    finally:
        if not partial:
            with _finals_lock:
                _finals_waiting -= 1


# Velocità della voce: length_scale di Piper (più alto = più lento).
SPEED = {"lenta": 1.15, "normale": 1.0, "veloce": 0.88}


def synthesize(text: str, speed: str = "normale", voice_name: str = "paola") -> bytes:
    voice = piper_voice(voice_name)
    buf = io.BytesIO()
    with tts_lock, wave.open(buf, "wb") as w:
        try:
            from piper import SynthesisConfig
            voice.synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=SPEED.get(speed, 1.0)))
        except ImportError:
            voice.synthesize_wav(text, w)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # niente contenuti nei log, solo le richieste
        pass

    def reply(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def json(self, code: int, obj):
        self.reply(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 16000 * 2 * MAX_AUDIO_SECONDS + 1024:
            raise ValueError("audio troppo lungo")
        return self.rfile.read(n)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            return self.json(200, {"ok": True})
        self.json(404, {"error": "non trovato"})

    def do_POST(self):
        url = urlparse(self.path)
        t0 = time.time()
        try:
            if url.path == "/stt":
                qs = parse_qs(url.query)
                partial = qs.get("partial", ["0"])[0] == "1"
                model = qs.get("model", [WHISPER])[0]
                prompt = qs.get("prompt", [""])[0][:600]
                audio = read_wav(self.body())
                text = transcribe(audio, partial, model, prompt)
                print(f"stt {model} {'parziale' if partial else 'finale'} {len(audio) / 16000:.1f}s audio in {time.time() - t0:.2f}s", flush=True)
                return self.json(200, {"text": text})
            if url.path == "/tts":
                req = json.loads(self.body() or b"{}")
                text = str(req.get("text", "")).strip()[:2000]
                if not text:
                    return self.json(400, {"error": "testo mancante"})
                wav = synthesize(text, str(req.get("speed", "normale")), str(req.get("voice", "paola")))
                print(f"tts {len(text)} caratteri in {time.time() - t0:.2f}s", flush=True)
                return self.reply(200, wav, "audio/wav")
            self.json(404, {"error": "non trovato"})
        except ValueError as e:
            self.json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 - l'errore va alla pagina, il servizio resta su
            print(f"errore: {e}", flush=True)
            self.json(500, {"error": "errore del servizio voce"})


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
