import type { FastifyInstance } from 'fastify';
import { settings, updateSettings } from './settings.js';
import { store } from './db.js';
import { connectProvider, disconnectProvider, externalStt, externalTts, isProvider, providerVoices, providers } from './voiceProviders.js';
import { OWNER } from './config.js';

// Voce di Ciccio: inoltra al servizio locale (voice/service.py, solo 127.0.0.1) trascrizione e sintesi.
// Le rotte stanno sotto /api, quindi da internet servono la sessione come tutto il resto.

const VOICE_URL = process.env.CICCIO_VOICE_URL ?? 'http://127.0.0.1:8791';

/**
 * Dizionario per Whisper: una frase con i nomi che l'utente dice a Ciccio (progetti, agenti, termini del mestiere).
 * Whisper la usa come «testo precedente» e scrive giusti quei nomi invece di storpiarli.
 */
const TERMS = ['agente', 'chat', 'deploy', 'commit', 'push', 'pull request', 'branch', 'server', 'repo', 'companion', 'Claude', 'GitHub'];
const projectNames = () => store.agents().filter((a) => !a.hidden).map((a) => (a.display_name?.trim() || a.id).replace(/[-_]+/g, ' ')).slice(0, 30);

function sttPrompt(): string {
  return `Ciccio, ${OWNER}. Progetti: ${projectNames().join(', ')}. ${TERMS.join(', ')}.`.slice(0, 600);
}

/** Lo stesso dizionario per i servizi esterni: un elenco di nomi e termini (Deepgram keyterm, prompt di OpenAI). */
const sttTerms = () => ['Ciccio', `${OWNER}`, ...projectNames(), ...TERMS].slice(0, 50);

export function registerVoice(app: FastifyInstance) {
  // Servizi esterni: elenco, collegamento (con verifica della chiave), scollegamento, voci.
  app.get('/api/voice/providers', async () => providers());
  app.post<{ Params: { id: string }; Body: { key?: string } }>('/api/voice/providers/:id', async (req, reply) => {
    if (!isProvider(req.params.id)) return reply.code(404).send({ error: 'servizio sconosciuto' });
    try { await connectProvider(req.params.id, req.body?.key ?? ''); return { providers: providers() }; }
    catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) }); }
  });
  app.post<{ Params: { id: string } }>('/api/voice/providers/:id/remove', async (req, reply) => {
    if (!isProvider(req.params.id)) return reply.code(404).send({ error: 'servizio sconosciuto' });
    const id = req.params.id;
    disconnectProvider(id);
    // Se era in uso, si torna ai servizi sul server.
    const s = settings();
    const patch: Record<string, unknown> = {};
    if (s.sttEngine === id) patch.sttEngine = 'whisper-base';
    if (s.ttsEngine === id) patch.ttsEngine = 'piper-paola';
    if (Object.keys(patch).length) updateSettings(patch);
    return { providers: providers() };
  });
  app.get<{ Params: { id: string } }>('/api/voice/providers/:id/voices', async (req, reply) => {
    if (!isProvider(req.params.id)) return reply.code(404).send({ error: 'servizio sconosciuto' });
    try { return await providerVoices(req.params.id); }
    catch (e) { return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.addContentTypeParser('audio/wav', { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get('/api/voice/health', async () => {
    try {
      const r = await fetch(`${VOICE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      return { ok: r.ok };
    } catch {
      return { ok: false };
    }
  });

  app.post<{ Querystring: { partial?: string }; Body: Buffer }>('/api/voice/stt', async (req, reply) => {
    const engine = settings().sttEngine;
    if (isProvider(engine)) {
      // Servizi esterni: niente trascrizione provvisoria (costerebbe ogni secondo), solo la frase finita.
      if (req.query.partial === '1') return { text: '' };
      try { return { text: await externalStt(engine, req.body, sttTerms()) }; }
      catch (e) { return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) }); }
    }
    try {
      // Modello scelto nelle Impostazioni (Whisper base o small, sul server).
      const model = settings().sttEngine === 'whisper-small' ? 'whisper-small' : 'whisper-base';
      const r = await fetch(`${VOICE_URL}/stt?model=${model}${req.query.partial === '1' ? '&partial=1' : ''}&prompt=${encodeURIComponent(sttPrompt())}`, {
        method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(req.body), signal: AbortSignal.timeout(60_000),
      });
      return reply.code(r.status).type('application/json').send(await r.text());
    } catch {
      return reply.code(503).send({ error: 'Servizio voce non disponibile' });
    }
  });

  app.post<{ Body: { text?: string; speed?: string } }>('/api/voice/tts', async (req, reply) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'testo mancante' });
    const s = settings();
    // Se il servizio esterno non va (chiave, credito, voce non permessa dal piano), Ciccio parla lo stesso con la
    // voce del server e la pagina riceve il motivo in un'intestazione: mai più risposte mute senza spiegazione.
    let notice = '';
    if (s.ttsEngine === 'openai' || s.ttsEngine === 'elevenlabs' || s.ttsEngine === 'deepgram') {
      try {
        const mp3 = await externalTts(s.ttsEngine, text.slice(0, 2000), s.ttsVoice, s.voiceSpeed);
        return reply.type('audio/mpeg').header('Cache-Control', 'no-store').send(mp3);
      } catch (e) {
        notice = `${e instanceof Error ? e.message : String(e)} Intanto parlo con la voce del server.`;
      }
    }
    if (notice) reply.header('X-Ciccio-Tts-Notice', encodeURIComponent(notice.slice(0, 300)));
    try {
      const r = await fetch(`${VOICE_URL}/tts`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, speed: settings().voiceSpeed, voice: settings().ttsEngine === 'piper-riccardo' ? 'riccardo' : 'paola' }), signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) return reply.code(r.status).type('application/json').send(await r.text());
      return reply.type('audio/wav').header('Cache-Control', 'no-store').send(Buffer.from(await r.arrayBuffer()));
    } catch {
      return reply.code(503).send({ error: 'Servizio voce non disponibile' });
    }
  });
}
