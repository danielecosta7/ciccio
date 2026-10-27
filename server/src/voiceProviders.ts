import { store } from './db.js';

// Servizi vocali esterni (Impostazioni › Voce): l'audio esce dal server verso il servizio scelto.
// Le chiavi stanno solo nel database del server; la pagina ne vede solo le ultime 4 cifre.
// I domini sono aperti nel firewall in uscita (deploy/egress-firewall.sh).

export type ProviderId = 'openai' | 'elevenlabs' | 'deepgram';

export interface ProviderView { id: ProviderId; name: string; connected: boolean; last4: string | null; stt: boolean; tts: boolean }

const PROVIDERS: Record<ProviderId, { name: string; stt: boolean; tts: boolean }> = {
  openai: { name: 'OpenAI', stt: true, tts: true },
  elevenlabs: { name: 'ElevenLabs', stt: true, tts: true },
  deepgram: { name: 'Deepgram', stt: true, tts: true },
};

type Keys = Partial<Record<ProviderId, string>>;
const keys = (): Keys => store.getKv<Keys>('voice_keys') ?? {};
const keyOf = (id: ProviderId) => {
  const k = keys()[id];
  if (!k) throw new Error(`${PROVIDERS[id].name} non è collegato: collegalo in Impostazioni › Voce.`);
  return k;
};

export function providers(): ProviderView[] {
  const k = keys();
  return (Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({
    id, name: PROVIDERS[id].name, connected: !!k[id], last4: k[id] ? k[id]!.slice(-4) : null, stt: PROVIDERS[id].stt, tts: PROVIDERS[id].tts,
  }));
}

export const isProvider = (v: string): v is ProviderId => v in PROVIDERS;

/** Prova la chiave con una richiesta che non costa nulla; se va, la salva. */
export async function connectProvider(id: ProviderId, key: string): Promise<void> {
  const k = key.trim();
  if (k.length < 12) throw new Error('Chiave troppo corta: copiala intera.');
  const check: Record<ProviderId, () => Promise<Response>> = {
    openai: () => fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(15_000) }),
    elevenlabs: () => fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': k }, signal: AbortSignal.timeout(15_000) }),
    deepgram: () => fetch('https://api.deepgram.com/v1/projects', { headers: { Authorization: `Token ${k}` }, signal: AbortSignal.timeout(15_000) }),
  };
  let res: Response;
  try { res = await check[id](); } catch { throw new Error(`${PROVIDERS[id].name} non risponde dal server.`); }
  if (res.status === 401 || res.status === 403) throw new Error('Chiave rifiutata: controlla di averla copiata intera e che sia attiva.');
  if (!res.ok) throw new Error(`${PROVIDERS[id].name} ha risposto ${res.status}.`);
  store.setKv('voice_keys', { ...keys(), [id]: k });
}

export function disconnectProvider(id: ProviderId) {
  const k = keys();
  delete k[id];
  store.setKv('voice_keys', k);
}

async function ensureOk(res: Response, who: string) {
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  if (res.status === 401) throw new Error(`${who}: chiave non più valida, ricollegalo in Impostazioni › Voce.`);
  if (res.status === 429) throw new Error(`${who}: limite o credito esaurito.`);
  if (res.status === 402) throw new Error(`${who}: questa voce richiede un piano a pagamento.`);
  throw new Error(`${who} ha risposto ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
}

/** Trascrizione con un servizio esterno (WAV mono 16 kHz). `terms`: nomi e parole da riconoscere giusti (progetti, termini). */
export async function externalStt(id: ProviderId, wav: Buffer, terms: string[] = []): Promise<string> {
  const blob = () => new Blob([new Uint8Array(wav)], { type: 'audio/wav' });
  if (id === 'openai') {
    const form = new FormData();
    form.append('file', blob(), 'audio.wav');
    form.append('model', 'gpt-4o-mini-transcribe');
    form.append('language', 'it');
    if (terms.length) form.append('prompt', `Conversazione con Ciccio. Nomi e termini: ${terms.join(', ')}.`);
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${keyOf(id)}` }, body: form, signal: AbortSignal.timeout(60_000) });
    await ensureOk(res, 'OpenAI');
    return String(((await res.json()) as { text?: string }).text ?? '').trim();
  }
  if (id === 'elevenlabs') {
    const form = new FormData();
    form.append('file', blob(), 'audio.wav');
    form.append('model_id', 'scribe_v1');
    form.append('language_code', 'ita');
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': keyOf(id) }, body: form, signal: AbortSignal.timeout(60_000) });
    await ensureOk(res, 'ElevenLabs');
    return String(((await res.json()) as { text?: string }).text ?? '').trim();
  }
  // keyterm, uno per parola o nome (le frasi con lo spazio vanno bene): Deepgram li riconosce giusti.
  const q = new URLSearchParams({ model: 'nova-3', language: 'it', smart_format: 'true' });
  for (const t of terms.slice(0, 50)) q.append('keyterm', t);
  const res = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
    method: 'POST', headers: { Authorization: `Token ${keyOf(id)}`, 'content-type': 'audio/wav' }, body: new Uint8Array(wav), signal: AbortSignal.timeout(60_000),
  });
  await ensureOk(res, 'Deepgram');
  const data = await res.json() as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
  return String(data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim();
}

const SPEED: Record<string, number> = { lenta: 0.9, normale: 1, veloce: 1.12 };

/** Voce con un servizio esterno: restituisce mp3. */
export async function externalTts(id: ProviderId, text: string, voice: string, speed: string): Promise<Buffer> {
  if (id === 'openai') {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { Authorization: `Bearer ${keyOf(id)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: voice || 'coral', input: text, response_format: 'mp3', speed: SPEED[speed] ?? 1, instructions: 'Parla in italiano, con tono naturale, caldo e diretto.' }),
      signal: AbortSignal.timeout(60_000),
    });
    await ensureOk(res, 'OpenAI');
    return Buffer.from(await res.arrayBuffer());
  }
  if (id === 'elevenlabs') {
    if (!voice) throw new Error('Scegli una voce ElevenLabs in Impostazioni › Voce.');
    const voiceId = await elevenVoiceId(voice);
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': keyOf(id), 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', language_code: 'it', voice_settings: { speed: SPEED[speed] ?? 1 } }),
      signal: AbortSignal.timeout(60_000),
    });
    await ensureOk(res, 'ElevenLabs');
    return Buffer.from(await res.arrayBuffer());
  }
  if (id === 'deepgram') {
    // Aura-2, voci italiane; mp3 come gli altri servizi. La velocità resta quella naturale della voce.
    const model = DEEPGRAM_VOICES.some((v) => v.id === voice) ? voice : DEEPGRAM_VOICES[0].id;
    const res = await fetch(`https://api.deepgram.com/v1/speak?model=${model}&encoding=mp3`, {
      method: 'POST', headers: { Authorization: `Token ${keyOf(id)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(60_000),
    });
    await ensureOk(res, 'Deepgram');
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('Questo servizio non offre la voce.');
}

/** Voci disponibili per la scelta nelle Impostazioni. */
export async function providerVoices(id: ProviderId): Promise<{ id: string; name: string; hint: string; group?: string; disabled?: boolean }[]> {
  if (id === 'openai') {
    return ['coral', 'sage', 'ballad', 'verse', 'alloy', 'ash', 'echo', 'shimmer', 'nova', 'onyx', 'fable']
      .map((v) => ({ id: v, name: v[0].toUpperCase() + v.slice(1), hint: '' }));
  }
  if (id === 'elevenlabs') {
    const headers = { 'xi-api-key': keyOf(id) };
    // Le voci del proprio account (poche, quasi tutte inglesi) più quelle italiane della libreria pubblica, le più usate prima.
    const [mine, library, sub] = await Promise.all([
      fetch('https://api.elevenlabs.io/v1/voices', { headers, signal: AbortSignal.timeout(15_000) }),
      fetch('https://api.elevenlabs.io/v1/shared-voices?language=it&page_size=100&sort=usage_character_count_1y', { headers, signal: AbortSignal.timeout(15_000) }),
      fetch('https://api.elevenlabs.io/v1/user/subscription', { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null),
    ]);
    // Con il piano gratuito le voci della libreria non si possono usare dall'API: si vedono, ma non si scelgono.
    const tier = sub?.ok ? String(((await sub.json()) as { tier?: string }).tier ?? '') : '';
    const free = tier === 'free';
    await ensureOk(mine, 'ElevenLabs');
    const own = ((await mine.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string> }[] }).voices ?? [];
    const shared = library.ok
      ? ((await library.json()) as { voices?: { voice_id: string; public_owner_id: string; name: string; gender?: string; age?: string; accent?: string; locale?: string | null }[] }).voices ?? []
      : [];
    const label = (s?: string | null) => (s ?? '').replace(/_/g, ' ');
    const ownVoices = own.map((v) => ({ id: v.voice_id, name: v.name, group: 'Del tuo account', hint: [v.labels?.gender, v.labels?.accent].filter(Boolean).join(' · ') }));
    const italian = shared.map((v) => ({
        id: `lib:${v.public_owner_id}:${v.voice_id}`, name: v.name.trim(), group: free ? 'Italiane · servono un piano a pagamento ElevenLabs' : 'Italiane', disabled: free,
        hint: [GENDER[v.gender ?? ''] ?? label(v.gender), AGE[v.age ?? ''] ?? label(v.age), v.accent === 'standard' ? '' : label(v.accent)].filter(Boolean).join(' · '),
      }));
    // Con il piano gratuito prima quelle che funzionano davvero.
    return free ? [...ownVoices, ...italian] : [...italian, ...ownVoices];
  }
  if (id === 'deepgram') return DEEPGRAM_VOICES.map((v) => ({ id: v.id, name: v.name, hint: v.hint }));
  return [];
}

/** Voci italiane di Deepgram Aura-2 (le prime due sono quelle consigliate da Deepgram). */
const DEEPGRAM_VOICES = [
  { id: 'aura-2-livia-it', name: 'Livia', hint: 'donna · consigliata' },
  { id: 'aura-2-dionisio-it', name: 'Dionisio', hint: 'uomo · consigliata' },
  { id: 'aura-2-melia-it', name: 'Melia', hint: 'donna' },
  { id: 'aura-2-maia-it', name: 'Maia', hint: 'donna' },
  { id: 'aura-2-cinzia-it', name: 'Cinzia', hint: 'donna' },
  { id: 'aura-2-demetra-it', name: 'Demetra', hint: 'donna' },
  { id: 'aura-2-elio-it', name: 'Elio', hint: 'uomo' },
  { id: 'aura-2-flavio-it', name: 'Flavio', hint: 'uomo' },
  { id: 'aura-2-cesare-it', name: 'Cesare', hint: 'uomo' },
];

const GENDER: Record<string, string> = { male: 'uomo', female: 'donna', neutral: 'neutra' };
const AGE: Record<string, string> = { young: 'giovane', middle_aged: 'adulta', old: 'anziana' };

/**
 * Le voci della libreria pubblica vanno aggiunte all'account prima di usarle via API:
 * la prima volta la aggiungo e mi segno l'id che ElevenLabs le dà nell'account.
 */
async function elevenVoiceId(voice: string): Promise<string> {
  if (!voice.startsWith('lib:')) return voice;
  const [, owner, voiceId] = voice.split(':');
  const added = store.getKv<Record<string, string>>('eleven_added') ?? {};
  if (added[voice]) return added[voice];
  const res = await fetch(`https://api.elevenlabs.io/v1/voices/add/${encodeURIComponent(owner)}/${encodeURIComponent(voiceId)}`, {
    method: 'POST', headers: { 'xi-api-key': keyOf('elevenlabs'), 'content-type': 'application/json' },
    body: JSON.stringify({ new_name: `Ciccio ${voiceId.slice(0, 6)}` }), signal: AbortSignal.timeout(20_000),
  });
  // Già aggiunta in passato (anche dal sito): l'id resta lo stesso.
  const id = res.ok ? String(((await res.json()) as { voice_id?: string }).voice_id ?? voiceId) : voiceId;
  if (!res.ok && res.status !== 400 && res.status !== 422) await ensureOk(res, 'ElevenLabs');
  store.setKv('eleven_added', { ...added, [voice]: id });
  return id;
}
