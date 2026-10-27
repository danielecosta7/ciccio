import { config } from './config.js';
import { isProvider, providers } from './voiceProviders.js';
import { voiceUp } from './voiceHealth.js';

const connected = (id: string) => providers().some((p) => p.id === id && p.connected);
import { deviceStore, store } from './db.js';
import { bus } from './bus.js';
import { EFFORTS, MODELS, PERMISSION_LEVELS, SUBAGENT_MODELS, type AppSettings, type Effort, type PermissionLevel } from '../../shared/types.js';

// Impostazioni dell'app: si cambiano dalla pagina Impostazioni o chiedendolo a Ciccio.
// Vivono nel database (kv "app_settings"); quello che manca prende il valore di partenza.

const DEFAULTS: AppSettings = {
  ciccioModel: config.ciccioModel,
  ciccioEffort: 'medium',
  // A voce conta la prontezza: Sonnet con poco ragionamento risponde in pochi secondi, con gli stessi strumenti.
  ciccioVoiceModel: 'claude-sonnet-5-5',
  ciccioVoiceEffort: 'low',
  noticeDone: true,
  noticeApprovals: true,
  noticeErrors: true,
  voiceReplies: true,
  defaultPermission: 'manual',
  defaultModel: config.agentModel,
  defaultEffort: 'high',
  // Sub-agent economici di partenza: Opus solo se l'utente lo consente.
  subagentModels: ['haiku', 'sonnet'],
  onePasswordDevice: '',
  maxActive: config.maxActive,
  recapHour: config.recapHour,
  autoCompact: true,
  autoCompactWindow: 250_000,
  ciccioLightSession: true,
  promptSuggestions: true,
  contextWarn: 80,
  micSensitivity: 'media',
  voiceSpeed: 'normale',
  ciccioSkills: true,
  // Base: ~2 s a frase sul VPS; small è più lento (6-7 s), troppo per una conversazione. I nomi li sistema il dizionario.
  sttEngine: 'whisper-base',
  ttsEngine: 'piper-paola',
  ttsVoice: '',
  // Le routine programmate saltano quando la finestra di 5 ore è già oltre l'80%.
  routineUsageLimit: 80,
  // Word, Excel e PowerPoint con il visore di Microsoft: il file esce dal server, quindi solo se lo accendi tu.
  officeOnline: false,
  timeZone: config.tz,
  voiceServer: true,
};

/**
 * Il primo indirizzo di CICCIO_ORIGINS raggiungibile da internet (non la tailnet, non la rete locale), o null: il visore
 * di Office online scarica i file da lì.
 */
export const publicOrigin = config.origins.find((o) => {
  const u = new URL(o);
  return u.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.|169\.254\.|\[)|\.(ts\.net|local|internal|localhost)$/i.test(u.hostname);
}) ?? null;

export function settings(): AppSettings {
  const s: AppSettings = { ...DEFAULTS, ...(store.getKv<Partial<AppSettings>>('app_settings') ?? {}), timeZone: config.tz, voiceServer: voiceUp() !== false };
  // Servizio voce spento o non installato: trascrizione del browser e voce del dispositivo al posto di Whisper e
  // Piper. La scelta salvata resta: torna appena il servizio risponde.
  if (!s.voiceServer) {
    if (s.sttEngine === 'whisper-base' || s.sttEngine === 'whisper-small') s.sttEngine = 'browser';
    if (s.ttsEngine === 'piper-paola' || s.ttsEngine === 'piper-riccardo') s.ttsEngine = 'device';
  }
  return s;
}

const isModel = (v: unknown): v is string => typeof v === 'string' && MODELS.some((m) => m.id === v);
const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as string[]).includes(v);
const isLevel = (v: unknown): v is PermissionLevel => typeof v === 'string' && PERMISSION_LEVELS.some((l) => l.key === v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/**
 * Applica solo i campi validi; restituisce le impostazioni risultanti e cosa è stato scartato. `byOwner` false (Ciccio):
 * niente che mandi file fuori dal server, lo decide solo l'utente dalla pagina.
 */
export function updateSettings(patch: Record<string, unknown>, byOwner = true): { settings: AppSettings; rejected: string[] } {
  const next: Partial<AppSettings> = { ...(store.getKv<Partial<AppSettings>>('app_settings') ?? {}) };
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'ciccioModel': case 'defaultModel': case 'ciccioVoiceModel': if (isModel(v)) next[k] = v; else rejected.push(k); break;
      case 'ciccioEffort': case 'defaultEffort': case 'ciccioVoiceEffort': if (isEffort(v)) next[k] = v; else rejected.push(k); break;
      case 'defaultPermission': if (isLevel(v)) next[k] = v; else rejected.push(k); break;
      // Almeno un modello, solo tra quelli noti, senza doppioni, nell'ordine dell'elenco.
      case 'subagentModels': {
        const ok = Array.isArray(v) && v.length > 0 && v.every((x) => SUBAGENT_MODELS.some((m) => m.id === x));
        if (ok) next[k] = SUBAGENT_MODELS.map((m) => m.id).filter((id) => (v as string[]).includes(id)); else rejected.push(k);
        break;
      }
      // Automatico ('') o un PC registrato con il companion.
      case 'onePasswordDevice': if (v === '' || (typeof v === 'string' && deviceStore.all().some((d) => d.id === v))) next[k] = v as string; else rejected.push(k); break;
      case 'noticeDone': case 'noticeApprovals': case 'noticeErrors': case 'voiceReplies': case 'autoCompact': case 'ciccioLightSession': case 'promptSuggestions': case 'ciccioSkills': if (isBool(v)) next[k] = v; else rejected.push(k); break;
      case 'autoCompactWindow': if (Number.isInteger(v) && ((v as number) === 0 || ((v as number) >= 100_000 && (v as number) <= 1_000_000))) next[k] = v as number; else rejected.push(k); break;
      case 'contextWarn': if (Number.isInteger(v) && (v as number) >= 50 && (v as number) <= 95) next[k] = v as number; else rejected.push(k); break;
      case 'micSensitivity': if (v === 'bassa' || v === 'media' || v === 'alta') next[k] = v; else rejected.push(k); break;
      case 'voiceSpeed': if (v === 'lenta' || v === 'normale' || v === 'veloce') next[k] = v; else rejected.push(k); break;
      // I servizi esterni si possono scegliere solo se collegati (chiave salvata).
      case 'sttEngine': if (v === 'whisper-base' || v === 'whisper-small' || v === 'browser' || (isProvider(String(v)) && connected(String(v)))) next[k] = v as AppSettings['sttEngine']; else rejected.push(k); break;
      case 'ttsEngine': if (v === 'piper-paola' || v === 'piper-riccardo' || v === 'device' || ((v === 'openai' || v === 'elevenlabs' || v === 'deepgram') && connected(v))) next[k] = v as AppSettings['ttsEngine']; else rejected.push(k); break;
      case 'ttsVoice': if (typeof v === 'string' && v.length <= 200) next[k] = v; else rejected.push(k); break;
      case 'maxActive': if (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10) next[k] = v as number; else rejected.push(k); break;
      case 'routineUsageLimit': if (Number.isInteger(v) && (v as number) >= 10 && (v as number) <= 100) next[k] = v as number; else rejected.push(k); break;
      case 'recapHour': if (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23) next[k] = v as number; else rejected.push(k); break;
      // Acceso solo con un indirizzo pubblico (i server di Microsoft non vedono la tailnet), spento sempre.
      case 'officeOnline': if (isBool(v) && byOwner && (!v || publicOrigin)) next[k] = v; else rejected.push(k); break;
      default: rejected.push(k);
    }
  }
  store.setKv('app_settings', next);
  const s = settings();
  bus.emit({ type: 'settings', settings: s });
  return { settings: s, rejected };
}
