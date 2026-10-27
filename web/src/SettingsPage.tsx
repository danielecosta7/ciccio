import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConnectorsSection, CredentialsSection, ExternalVoicePicker, ServerSection, SkillsSection, VoiceProvidersSection } from './SettingsExtras';
import { Speaker, deviceVoices } from './voice/speaker';
import { configureSpeaker, deviceVoiceName } from './voice/hooks';
import { motion } from 'motion/react';
import { Disclosure, DisclosureGroup } from '@heroui/react';
import { api, timeAgo } from './api';
import { AuthControls } from './Auth';
import { ClaudeUsage, PixelMark } from './ui';
import { PcToolsSection } from './chat/PcTools';
import { DesktopAppSection } from './DesktopApp';
import { RoutinesSection } from './Routines';
import { ScreenInfo } from './ScreenInfo';
import { ConsumiSection } from './Consumi';
import { PhoneSteps, SetupChecklist, type SetupHook } from './Setup';
import { smooth } from './motion';
import { EFFORTS, MODELS, PERMISSION_LEVELS, SUBAGENT_MODELS, type AgentView, type AppSettings, type CompanionView, type DesktopAppView, type PasskeyView, type UsageState, type VoiceProviderView } from '../../shared/types';

// Impostazioni di Ciccio in un posto solo: Ciccio, chat nuove, progetti, PC, accesso, uso.
// Tutto vale subito e si può chiedere anche a Ciccio ("metti le chat nuove in Accetta modifiche").

const SECTIONS = [
  { id: 'configurazione', label: 'Configurazione' },
  { id: 'ciccio', label: 'Ciccio' },
  { id: 'chat', label: 'Chat' },
  { id: 'routine', label: 'Routine' },
  { id: 'voce', label: 'Voce' },
  { id: 'progetti', label: 'Progetti' },
  { id: 'connettori', label: 'Connettori' },
  { id: 'skill', label: 'Skill' },
  { id: 'pc', label: 'Companion' },
  { id: 'app', label: 'App' },
  { id: 'credenziali', label: 'Credenziali' },
  { id: 'accesso', label: 'Accesso' },
  { id: 'server', label: 'Server' },
  { id: 'consumi', label: 'Consumi' },
  { id: 'uso', label: 'Uso di Claude' },
  { id: 'schermo', label: 'Schermo' },
] as const;

const STT_OPTIONS: { key: AppSettings['sttEngine']; label: string; hint: string; private: boolean }[] = [
  { key: 'whisper-base', label: 'Whisper base · sul tuo server', hint: 'Veloce: una frase in circa 2 secondi. Precisione buona.', private: true },
  { key: 'whisper-small', label: 'Whisper small · sul tuo server', hint: 'Più preciso con nomi e parole difficili, più lento: 6-7 secondi a frase.', private: true },
  { key: 'browser', label: 'Riconoscimento del browser', hint: 'Immediato e con il testo che scorre mentre parli, ma Chrome manda l\'audio a Google e Safari ad Apple. Non tutti i browser lo hanno.', private: false },
];

const EXTERNAL_STT: typeof STT_OPTIONS = [
  { key: 'deepgram', label: 'Deepgram Nova-3', hint: 'Rapidissimo: la frase arriva quasi subito.', private: false },
  { key: 'openai', label: 'OpenAI gpt-4o-mini-transcribe', hint: 'Preciso e veloce.', private: false },
  { key: 'elevenlabs', label: 'ElevenLabs Scribe', hint: 'Molto preciso con nomi e termini tecnici.', private: false },
];

const EXTERNAL_TTS: { key: AppSettings['ttsEngine']; label: string; hint: string; where: string }[] = [
  { key: 'elevenlabs', label: 'ElevenLabs', hint: 'Le voci più realistiche, scegli quale qui sotto.', where: 'servizio esterno' },
  { key: 'openai', label: 'OpenAI', hint: 'Voci naturali, scegli quale qui sotto.', where: 'servizio esterno' },
  { key: 'deepgram', label: 'Deepgram Aura-2', hint: 'Voci italiane naturali e rapide, scegli quale qui sotto.', where: 'servizio esterno' },
];

const TTS_OPTIONS: { key: AppSettings['ttsEngine']; label: string; hint: string; where: string }[] = [
  { key: 'piper-paola', label: 'Paola · Piper sul tuo server', hint: 'Voce femminile, chiara. Uguale su ogni dispositivo.', where: 'sul server' },
  { key: 'piper-riccardo', label: 'Riccardo · Piper sul tuo server', hint: 'Voce maschile, più leggera e veloce da generare.', where: 'sul server' },
  { key: 'device', label: 'Voce del dispositivo', hint: 'Le voci del telefono o del computer: su iPhone e Mac quelle «migliorate» sono molto naturali. Generata sul dispositivo, scegli quale qui sotto.', where: 'sul dispositivo' },
];

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={`cc-touch relative h-[24px] w-[42px] flex-none rounded-full transition-colors duration-150 ${on ? 'bg-acid' : 'bg-line-hi'}`}>
      <span className={`absolute top-[3px] h-[18px] w-[18px] rounded-full transition-[left] duration-150 ${on ? 'left-[21px] bg-ink' : 'left-[3px] bg-soft'}`} />
    </button>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line/60 py-3.5 first:border-t-0 first:pt-0">
      <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium">{title}</span>
        {hint && <span className="text-[12.5px] leading-snug text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// Sezioni apribili (DisclosureGroup di HeroUI): aperta quella su cui arrivi (menu a sinistra o link #sezione),
// le altre come le avevi lasciate su questo dispositivo. Da chiusa mostra un riassunto, per vedere lo stato senza aprirla.
const OPEN_KEY = 'ciccio.settingsOpen';
const OPEN_EVENT = 'ciccio:settings-open';
function initialOpen(): Set<string> {
  let stored: string[] | null = null;
  try { const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null') as unknown; if (Array.isArray(v)) stored = v.filter((x): x is string => typeof x === 'string'); } catch { /* memoria non disponibile */ }
  // Prima volta su questo dispositivo: aperta solo la prima sezione.
  const open = new Set(stored ?? [SECTIONS[0].id]);
  if (location.hash) open.add(location.hash.slice(1));
  return open;
}
/** Apre una sezione e ci porta (anche se il link è già quello attuale, quando hashchange non scatta). */
function openSection(id: string) { window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id })); }

function useOpenSections() {
  const [open, setOpen] = useState(initialOpen);
  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...open])); } catch { /* memoria non disponibile: si riparte dai valori di partenza */ }
  }, [open]);
  useEffect(() => {
    const reveal = (id: string) => {
      if (!SECTIONS.some((x) => x.id === id)) return;
      setOpen((prev) => new Set(prev).add(id));
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    };
    const onHash = () => reveal(location.hash.slice(1));
    const onOpen = (e: Event) => reveal((e as CustomEvent<string>).detail);
    window.addEventListener('hashchange', onHash);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener(OPEN_EVENT, onOpen); };
  }, []);
  return [open, (keys: Set<string | number>) => setOpen(new Set([...keys].map(String)))] as const;
}

function Card({ id, title, intro, summary, children, index, open }: { id: string; title: string; intro?: string; summary?: string; children: ReactNode; index: number; open: boolean }) {
  // Il contenuto si monta alla prima apertura (ogni sezione carica i suoi dati solo se la guardi) e poi resta, per l'animazione di chiusura.
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  return (
    <motion.section id={id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0, transition: { ...smooth, delay: index * 0.04 } }}
      // Sopra le sezioni dopo mentre la usi: i riquadri che si aprono sotto un pulsante (es. il codice di «Aggiungi
      // dispositivo») sporgono sulla sezione successiva e devono restare davanti, cliccabili.
      className="relative scroll-mt-24 rounded-[14px] border border-line bg-panel focus-within:z-20 hover:z-20">
      <Disclosure id={id}>
        <Disclosure.Heading level={2} className="m-0">
          <Disclosure.Trigger className="flex w-full items-start gap-3 rounded-[14px] px-5 py-4 text-left hover:bg-panel-hi/40 sm:px-6">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[17px] font-semibold tracking-[-0.01em] text-acid">{title}</span>
              {!open && (summary || intro) && <span className="truncate text-[13px] font-normal text-muted">{summary || intro}</span>}
            </span>
            <Disclosure.Indicator className="mt-1 size-[18px] text-muted" />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <div className="px-5 pb-5 sm:px-6 sm:pb-6">
            {seen && (
              <>
                {intro && <p className="m-0 mb-4 max-w-[65ch] text-[13px] leading-relaxed text-muted">{intro}</p>}
                {children}
              </>
            )}
          </div>
        </Disclosure.Content>
      </Disclosure>
    </motion.section>
  );
}

/** «il 50%», «l'80%»: l'articolo giusto davanti alla percentuale. */
const pct = (n: number) => (/^(1|8|11|8\d)$/.test(String(n)) ? `l'${n}%` : `il ${n}%`);

const select = 'min-h-10 rounded-[10px] border border-line bg-ink px-3 text-[14px] text-text outline-none hover:border-line-hi focus:border-acid';

export function SettingsPage(props: {
  settings: AppSettings | null;
  onSettings: (s: AppSettings) => void;
  agents: AgentView[];
  usage: UsageState | null;
  /** Torna alla dashboard; sul telefono non c'è, le Impostazioni sono una scheda della barra in basso. */
  onBack?: () => void;
  onNewProject: (mode: 'new' | 'github') => void;
  companions: CompanionView[];
  desktopApps: DesktopAppView[];
  onOpenChat: (agentId: string, chatId: string) => void;
  /** Stato della configurazione del server (lo legge App, che ne mostra anche il badge in dashboard). */
  setup: SetupHook;
}) {
  const s = props.settings;
  // Servizio voce del server spento o non installato: solo browser, dispositivo e servizi esterni.
  const local = (o: { key: string }) => s?.voiceServer !== false || !/^(whisper|piper)-/.test(o.key);
  const [error, setError] = useState('');
  const [passkeys, setPasskeys] = useState<PasskeyView[] | null>(null);
  const [q, setQ] = useState('');
  const [showHidden, setShowHidden] = useState(true);
  const [open, setOpen] = useOpenSections();
  const [notify, setNotify] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted');

  const tester = useRef<Speaker | null>(null);
  const nativePcs = props.companions.filter((x) => x.online && x.notifications);
  const [providers, setProviders] = useState<VoiceProviderView[] | null>(null);
  useEffect(() => { void fetch('/api/voice/providers').then((r) => r.json()).then((d) => setProviders(d as VoiceProviderView[])).catch(() => setProviders([])); }, []);
  // Voci italiane del dispositivo: arrivano dopo un attimo (onvoiceschanged).
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => deviceVoices());
  const [deviceVoice, setDeviceVoice] = useState(deviceVoiceName);
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return undefined;
    const load = () => setVoices(deviceVoices());
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);
  const loadPasskeys = () => void api.passkeys().then(setPasskeys).catch(() => setPasskeys([]));
  useEffect(loadPasskeys, []);

  const save = (patch: Partial<AppSettings>) => {
    setError('');
    if (s) props.onSettings({ ...s, ...patch });
    void api.updateAppSettings(patch).then((r) => {
      props.onSettings(r.settings);
      // Il visore di Office online si accende solo con un indirizzo pubblico: i server di Microsoft non vedono la tailnet.
      if (r.rejected.includes('officeOnline')) setError('Il visore di Office online serve un indirizzo pubblico in CICCIO_ORIGINS.');
    }).catch((e: Error) => setError(e.message));
  };

  // Riassunti delle sezioni chiuse.
  const modelName = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id;
  const sum = s ? {
    ciccio: `${modelName(s.ciccioModel)} · ${s.ciccioEffort} · avvisi ${[s.noticeDone && 'giri finiti', s.noticeApprovals && 'permessi', s.noticeErrors && 'errori'].filter(Boolean).join(', ') || 'spenti'}`,
    chat: `${PERMISSION_LEVELS.find((l) => l.key === s.defaultPermission)?.label ?? s.defaultPermission} · ${modelName(s.defaultModel)} ${s.defaultEffort} · sub-agent ${SUBAGENT_MODELS.filter((m) => s.subagentModels?.includes(m.id)).map((m) => m.label).join('/')} · ${s.maxActive} insieme`,
    voce: `${[...STT_OPTIONS, ...EXTERNAL_STT].find((o) => o.key === s.sttEngine)?.label ?? s.sttEngine} · ${[...TTS_OPTIONS, ...EXTERNAL_TTS].find((o) => o.key === s.ttsEngine)?.label ?? s.ttsEngine}`,
  } : null;

  const projects = useMemo(() => {
    const t = q.trim().toLowerCase();
    return [...props.agents].filter((a) => (showHidden || !a.hidden) && (!t || `${a.name} ${a.id}`.toLowerCase().includes(t)))
      .sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name));
  }, [props.agents, q, showHidden]);

  return (
    <div className="cc-safe-x min-h-dvh">
      {/* La safe area sta nella barra fissa, così scorrendo i titoli non finiscono sotto l'isola dinamica. */}
      <header className="cc-safe-top sticky top-0 z-20 border-b border-line/70 bg-ink/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1100px] items-center gap-3 px-4 py-3 sm:px-8">
          {props.onBack && <button type="button" onClick={props.onBack} aria-label="Torna alla dashboard"
            className="cc-press flex h-9 flex-none items-center gap-1.5 rounded-[8px] border border-line px-2.5 text-[13px] text-soft hover:text-text">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
            <span className="hidden md:inline">Dashboard</span>
          </button>}
          <PixelMark size={32} />
          <h1 className="pixel-16 m-0">Impostazioni</h1>
          {error && <span className="ml-auto text-[13px] text-block">{error}</span>}
        </div>
      </header>

      {/* Sotto i 768 px l'indice delle sezioni è una riga che scorre, sotto la barra. */}
      <nav aria-label="Sezioni" className="cc-hscroll sticky top-[calc(var(--cc-top)+57px)] z-10 border-b border-line/70 bg-ink/90 backdrop-blur-sm md:hidden">
        <div className="flex w-max gap-1.5 px-4 py-2">
          {SECTIONS.map((x) => (
            <a key={x.id} href={`#${x.id}`} onClick={() => openSection(x.id)} className="flex min-h-9 flex-none items-center rounded-full border border-line px-3 text-[13px] text-soft no-underline">{x.label}</a>
          ))}
        </div>
      </nav>
      <div className="mx-auto flex max-w-[1100px] gap-8 px-4 pt-6 pb-32 sm:px-8 sm:pb-24">
        <nav aria-label="Sezioni" className="sticky top-20 hidden h-fit w-[180px] flex-none flex-col gap-0.5 md:flex">
          {SECTIONS.map((x) => (
            <a key={x.id} href={`#${x.id}`} onClick={() => openSection(x.id)} className="rounded-[8px] px-3 py-2 text-[13.5px] text-soft hover:bg-panel hover:text-text">{x.label}</a>
          ))}
          <p className="mt-4 px-3 text-[12px] leading-relaxed text-muted">Puoi anche chiederlo a Ciccio: «metti le chat nuove in Accetta modifiche».</p>
        </nav>

        <main className="min-w-0 flex-1">
          {/* Senza il contain di HeroUI: non deve diventare il riferimento di eventuali elementi fixed nelle sezioni. */}
          <DisclosureGroup allowsMultipleExpanded expandedKeys={open} onExpandedChange={setOpen} className="flex flex-col gap-5 [contain:none]">
          <Card id="configurazione" open={open.has('configurazione')} index={0} title="Configurazione"
            summary={props.setup.report ? (props.setup.report.mancano ? `${props.setup.report.mancano} da fare` : 'tutto quello che serve è a posto') : undefined}
            intro="Cosa serve a Ciccio sul tuo server, controllato adesso. Apri una voce per sistemarla passo per passo; quelle da root si fanno sul server con un comando da copiare.">
            <SetupChecklist setup={props.setup} onGo={openSection} />
          </Card>

          <Card id="ciccio" open={open.has('ciccio')} index={0} summary={sum?.ciccio} title="Ciccio" intro="Il modello che usa, quando ti avvisa da solo e come ti risponde.">
            {s && (
              <>
                <Row title="Modello" hint="Per la chat scritta con Ciccio e il riepilogo del mattino. Quello per la voce è in Voce.">
                  <div className="flex gap-2">
                    <select aria-label="Modello di Ciccio" value={s.ciccioModel} onChange={(e) => save({ ciccioModel: e.target.value })} className={select}>
                      {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                    <select aria-label="Effort di Ciccio" value={s.ciccioEffort} onChange={(e) => save({ ciccioEffort: e.target.value as AppSettings['ciccioEffort'] })} className={select}>
                      {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </div>
                </Row>
                <Row title="Avvisa quando un agente finisce" hint="Due righe di riassunto nella chat di Ciccio, se non stai già guardando quella chat.">
                  <Switch on={s.noticeDone} onChange={(v) => save({ noticeDone: v })} label="Avvisi a fine giro" />
                </Row>
                <Row title="Avvisa quando un agente chiede un permesso">
                  <Switch on={s.noticeApprovals} onChange={(v) => save({ noticeApprovals: v })} label="Avvisi sui permessi" />
                </Row>
                <Row title="Avvisa quando un agente si blocca">
                  <Switch on={s.noticeErrors} onChange={(v) => save({ noticeErrors: v })} label="Avvisi sugli errori" />
                </Row>
                <Row title="Notifiche del computer" hint={nativePcs.length
                  ? `Arrivano da Ciccio Companion su ${nativePcs.map((x) => x.name).join(' e ')}: notifiche del sistema con l'icona di Ciccio, anche a browser chiuso. Quelle del browser servono solo quando nessun PC con il companion è acceso.`
                  : "Gli avvisi arrivano anche quando Ciccio è in un'altra scheda. Con Ciccio Companion acceso arrivano come notifiche del sistema, anche a browser chiuso. Quelle del browser si tolgono dalle sue impostazioni."}>
                  {typeof Notification === 'undefined'
                    ? <span className="text-[13px] text-muted">Non supportate qui</span>
                    : notify
                      ? <span className="text-[13px] text-acid">Attive</span>
                      : <button type="button" onClick={() => void Notification.requestPermission().then((p) => setNotify(p === 'granted'))}
                          className="cc-press min-h-10 rounded-[10px] border border-line-hi px-4 text-[13.5px]">Attiva</button>}
                </Row>
                <Row title="Usa le skill" hint="Ciccio usa anche le skill installate qui sotto, come gli agenti.">
                  <Switch on={s.ciccioSkills} onChange={(v) => save({ ciccioSkills: v })} label="Skill per Ciccio" />
                </Row>
                <Row title="Sessione leggera" hint="Dopo un'ora di pausa (quindi anche ogni mattina) o quando la conversazione supera i 150k, Ciccio riparte con una sessione nuova e gli ultimi messaggi come promemoria: costa molto meno, soprattutto a voce. Spenta, ricorda tutto ma ogni messaggio rilegge l'intera conversazione.">
                  <Switch on={s.ciccioLightSession} onChange={(v) => save({ ciccioLightSession: v })} label="Sessione leggera di Ciccio" />
                </Row>
                <Row title="Riepilogo del mattino" hint={`Ora (fuso ${s.timeZone}) in cui Ciccio prepara il riepilogo del giorno.`}>
                  <select aria-label="Ora del riepilogo" value={s.recapHour} onChange={(e) => save({ recapHour: Number(e.target.value) })} className={select}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                  </select>
                </Row>
              </>
            )}
          </Card>

          <Card id="chat" open={open.has('chat')} index={1} summary={sum?.chat} title="Chat" intro="Come partono le chat che apri da qui in avanti (ogni chat poi si cambia da sola, come in Claude Code) e come si gestisce il contesto delle sessioni.">
            {s && (
              <>
                <div className="mb-4 flex flex-col gap-1.5" role="radiogroup" aria-label="Livello di autorizzazione predefinito">
                  {PERMISSION_LEVELS.map((l) => {
                    const on = s.defaultPermission === l.key;
                    return (
                      <button key={l.key} type="button" role="radio" aria-checked={on} onClick={() => save({ defaultPermission: l.key })}
                        className={`flex flex-col gap-0.5 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors ${on ? (l.key === 'bypass' ? 'border-wait/70 bg-wait/[.06]' : 'border-acid/70 bg-acid/[.05]') : 'border-line hover:border-line-hi'}`}>
                        <span className={`text-[14px] font-medium ${on && l.key === 'bypass' ? 'text-wait' : ''}`}>{l.label}</span>
                        <span className="text-[12.5px] leading-snug text-muted">{l.hint}</span>
                      </button>
                    );
                  })}
                </div>
                <Row title="Modello ed effort">
                  <div className="flex gap-2">
                    <select aria-label="Modello predefinito" value={s.defaultModel} onChange={(e) => save({ defaultModel: e.target.value })} className={select}>
                      {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                    <select aria-label="Effort predefinito" value={s.defaultEffort} onChange={(e) => save({ defaultEffort: e.target.value as AppSettings['defaultEffort'] })} className={select}>
                      {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </div>
                </Row>
                <Row title="Modelli dei sub-agent" hint="Per i lavori grandi gli agenti lanciano sub-agent. Possono usare solo i modelli accesi qui: se ne chiedono un altro, Ciccio lo sostituisce con il più vicino. Vale subito, anche per le chat già aperte.">
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Modelli consentiti per i sub-agent">
                    {SUBAGENT_MODELS.map((m) => {
                      const on = (s.subagentModels ?? []).includes(m.id);
                      const last = on && s.subagentModels.length === 1;
                      return (
                        <button key={m.id} type="button" aria-pressed={on} disabled={last} aria-label={`${m.label}: ${m.hint}`} title={last ? 'Serve almeno un modello' : undefined}
                          onClick={() => save({ subagentModels: on ? s.subagentModels.filter((x) => x !== m.id) : SUBAGENT_MODELS.map((x) => x.id).filter((x) => x === m.id || s.subagentModels.includes(x)) })}
                          className={`cc-press flex min-h-10 flex-col items-start rounded-[10px] border px-3 py-1.5 text-left transition-colors ${on ? 'border-acid/70 bg-acid/[.06]' : 'border-line hover:border-line-hi'} disabled:cursor-not-allowed`}>
                          <span className={`flex items-center gap-1.5 text-[13.5px] font-medium ${on ? 'text-text' : 'text-muted'}`}>
                            <span aria-hidden className={`flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border text-[10px] leading-none ${on ? 'border-acid bg-acid text-ink' : 'border-line-hi'}`}>{on ? '✓' : ''}</span>
                            {m.label}
                          </span>
                          <span className="text-[11.5px] text-muted">{m.hint}</span>
                        </button>
                      );
                    })}
                  </div>
                </Row>
                <Row title="Chat al lavoro insieme" hint="Le altre aspettano in coda e partono appena si libera un posto.">
                  <div className="flex items-center gap-2">
                    <button type="button" aria-label="Una in meno" disabled={s.maxActive <= 1} onClick={() => save({ maxActive: s.maxActive - 1 })} className="cc-press h-10 w-10 rounded-[10px] border border-line text-[18px] disabled:opacity-40">−</button>
                    <span className="w-8 text-center font-mono text-[16px] text-acid">{s.maxActive}</span>
                    <button type="button" aria-label="Una in più" disabled={s.maxActive >= 10} onClick={() => save({ maxActive: s.maxActive + 1 })} className="cc-press h-10 w-10 rounded-[10px] border border-line text-[18px] disabled:opacity-40">+</button>
                  </div>
                </Row>
                <Row title="Prompt suggerito" hint={`A fine giro Claude propone il messaggio successivo (Tab per usarlo). Costa una chiamata in più per ogni giro, che rilegge tutto il contesto della chat: spegnilo se il limite di 5 ore ti va stretto.`}>
                  <Switch on={s.promptSuggestions} onChange={(v) => save({ promptSuggestions: v })} label="Prompt suggerito" />
                </Row>
                <Row title="Compressione automatica" hint="Quando il contesto di una sessione si riempie, Claude la riassume da solo e continua (come in Claude Code). Spenta, decidi tu: Comprimi o Nuova sessione.">
                  <Switch on={s.autoCompact} onChange={(v) => save({ autoCompact: v })} label="Compressione automatica" />
                </Row>
                {s.autoCompact && (
                  <Row title="Comprimi oltre" hint="Le chat rileggono tutto il contesto a ogni chiamata: oltre questa soglia Claude riassume le parti vecchie e continua. Più bassa = meno consumo; le ultime cose fatte restano intere, i dettagli lontani li rilegge se servono.">
                    <select aria-label="Soglia della compressione automatica" value={s.autoCompactWindow} onChange={(e) => save({ autoCompactWindow: Number(e.target.value) })} className={select}>
                      {[[150_000, '150 mila'], [250_000, '250 mila (consigliata)'], [400_000, '400 mila'], [600_000, '600 mila'], [0, 'Al limite del modello']].map(([n, l]) => <option key={n} value={n}>{l}</option>)}
                    </select>
                  </Row>
                )}
                <Row title="Avviso di contesto" hint="Oltre questa soglia la chat ti propone di comprimere o di ripartire con una sessione nuova.">
                  <select aria-label="Soglia di avviso del contesto" value={s.contextWarn} onChange={(e) => save({ contextWarn: Number(e.target.value) })} className={select}>
                    {[60, 70, 80, 90].map((n) => <option key={n} value={n}>{n}%</option>)}
                  </select>
                </Row>
                <Row title="Visore di Office online" hint="Word, Excel e PowerPoint con la grafica vera, nel visore di Microsoft: per aprirli i server di Microsoft scaricano il file da Ciccio, con un link valido mezz'ora. Serve un indirizzo pubblico in CICCIO_ORIGINS. Spento, Excel e Word si leggono qui, senza la grafica del file.">
                  <Switch on={s.officeOnline} onChange={(v) => save({ officeOnline: v })} label="Visore di Office online" />
                </Row>
              </>
            )}
          </Card>

          <Card id="routine" open={open.has('routine')} index={2} summary={s ? (s.routineUsageLimit >= 100 ? 'nessuna soglia sull\'uso' : `saltano oltre ${pct(s.routineUsageLimit)} della finestra di 5 ore`) : undefined} title="Routine"
            intro={`Messaggi che Ciccio manda da solo a un progetto, a orari fissi (fuso ${s?.timeZone ?? 'del server'}), come se li scrivessi tu. L'esito ti arriva come gli altri avvisi. Ogni esecuzione è un giro completo dell'agente: consuma come un tuo messaggio.`}>
            {/* La soglia guarda la finestra di 5 ore dell'abbonamento. */}
            {s && (
              <Row title="Soglia sull'uso" hint="Se la finestra di 5 ore è già oltre questa soglia, le esecuzioni programmate saltano (e te lo dice). «Lancia ora» parte comunque. 100% = mai.">
                <select value={s.routineUsageLimit} onChange={(e) => save({ routineUsageLimit: Number(e.target.value) })} className={select} aria-label="Soglia sull'uso per le routine">
                  {[50, 60, 70, 80, 90, 100].map((n) => <option key={n} value={n}>{n === 100 ? 'mai' : `oltre ${pct(n)}`}</option>)}
                </select>
              </Row>
            )}
            <div className="mt-3 border-t border-line/60 pt-4">
              <RoutinesSection agents={props.agents} onOpenChat={props.onOpenChat} />
            </div>
          </Card>

          <Card id="voce" open={open.has('voce')} index={2} summary={sum?.voce} title="Voce" intro="Scegli chi trascrive quello che dici e con che voce ti risponde Ciccio. Si cambia quando vuoi: vale dalla prossima volta che parli.">
            {s && (
              <>
                {!s.voiceServer && <p className="m-0 mb-3 text-[12.5px] leading-snug text-muted">Il servizio voce del server (Whisper e Piper) non risponde o non è installato: per ora valgono il browser e la voce del dispositivo. Per averlo, <code className="font-mono">bash deploy/install-voice.sh</code> sul server.</p>}
                <div className="mb-1 text-[13px] font-semibold">Trascrizione</div>
                <div className="mb-4 flex flex-col gap-1.5" role="radiogroup" aria-label="Servizio di trascrizione">
                  {[...STT_OPTIONS.filter(local), ...EXTERNAL_STT.filter((o) => providers?.some((p) => p.id === o.key && p.connected))].map((o) => (
                    <button key={o.key} type="button" role="radio" aria-checked={s.sttEngine === o.key} onClick={() => save({ sttEngine: o.key })}
                      className={`flex flex-col gap-0.5 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors ${s.sttEngine === o.key ? 'border-acid/70 bg-acid/[.05]' : 'border-line hover:border-line-hi'}`}>
                      <span className="flex items-center justify-between gap-2 text-[14px] font-medium">{o.label}<span className={`text-[11.5px] font-normal ${o.private ? 'text-done' : 'text-wait'}`}>{o.private ? 'resta sul server' : 'audio a terzi'}</span></span>
                      <span className="text-[12.5px] leading-snug text-muted">{o.hint}</span>
                    </button>
                  ))}
                </div>
                <div className="mb-1 text-[13px] font-semibold">Voce di Ciccio</div>
                <div className="mb-2 flex flex-col gap-1.5" role="radiogroup" aria-label="Voce di Ciccio">
                  {[...TTS_OPTIONS.filter(local), ...EXTERNAL_TTS.filter((o) => providers?.some((p) => p.id === o.key && p.connected))].map((o) => (
                    <button key={o.key} type="button" role="radio" aria-checked={s.ttsEngine === o.key} onClick={() => save({ ttsEngine: o.key })}
                      className={`flex flex-col gap-0.5 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors ${s.ttsEngine === o.key ? 'border-acid/70 bg-acid/[.05]' : 'border-line hover:border-line-hi'}`}>
                      <span className="flex items-center justify-between gap-2 text-[14px] font-medium">{o.label}<span className={`text-[11.5px] font-normal ${o.where === 'servizio esterno' ? 'text-wait' : 'text-done'}`}>{o.where}</span></span>
                      <span className="text-[12.5px] leading-snug text-muted">{o.hint}</span>
                    </button>
                  ))}
                </div>
                {(s.ttsEngine === 'openai' || s.ttsEngine === 'elevenlabs' || s.ttsEngine === 'deepgram') && (
                  <Row title="Voce" hint="Le voci del servizio esterno collegato.">
                    <ExternalVoicePicker engine={s.ttsEngine} value={s.ttsVoice} onChange={(v) => save({ ttsVoice: v })} />
                  </Row>
                )}
                {s.ttsEngine === 'device' && (
                  <Row title="Voce del dispositivo" hint="Vale solo su questo dispositivo. Su iPhone e Mac scarichi voci più naturali in Impostazioni › Accessibilità › Contenuto letto › Voci › Italiano.">
                    <select aria-label="Voce del dispositivo" value={deviceVoice} onChange={(e) => { setDeviceVoice(e.target.value); try { localStorage.setItem('ciccio.deviceVoice', e.target.value); } catch { /* memoria non disponibile */ } }} className={select}>
                      {voices.length === 0 && <option value="">Nessuna voce italiana</option>}
                      {voices.map((v) => <option key={v.name} value={v.name}>{v.name}{v.localService ? '' : ' (online)'}</option>)}
                    </select>
                  </Row>
                )}
                <Row title="Modello quando parli" hint="Per la conversazione a voce: Sonnet con poco ragionamento risponde in pochi secondi, con gli stessi strumenti.">
                  <div className="flex gap-2">
                    <select aria-label="Modello di Ciccio a voce" value={s.ciccioVoiceModel} onChange={(e) => save({ ciccioVoiceModel: e.target.value })} className={select}>
                      {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                    <select aria-label="Effort di Ciccio a voce" value={s.ciccioVoiceEffort} onChange={(e) => save({ ciccioVoiceEffort: e.target.value as AppSettings['ciccioVoiceEffort'] })} className={select}>
                      {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </div>
                </Row>
                <Row title="Rispondi a voce" hint="Quando gli parli, Ciccio ti legge la risposta.">
                  <Switch on={s.voiceReplies} onChange={(v) => save({ voiceReplies: v })} label="Risposte a voce" />
                </Row>
                <div className="mt-3 mb-1 text-[13px] font-semibold">Servizi esterni</div>
                <p className="m-0 mb-2 text-[12.5px] leading-snug text-muted">Più veloci o con voci più realistiche, ma l'audio esce dal server verso il servizio. Ognuno si collega con la sua chiave, passo per passo.</p>
                <div className="mb-3"><VoiceProvidersSection settings={s} onUse={save} list={providers} onList={setProviders} /></div>
                <Row title="Sensibilità del microfono" hint="Alta ti sente anche a voce bassa; bassa ignora meglio i rumori intorno.">
                  <select aria-label="Sensibilità del microfono" value={s.micSensitivity} onChange={(e) => save({ micSensitivity: e.target.value as AppSettings['micSensitivity'] })} className={select}>
                    <option value="bassa">Bassa</option><option value="media">Media</option><option value="alta">Alta</option>
                  </select>
                </Row>
                <Row title="Velocità della voce">
                  <div className="flex gap-2">
                    <select aria-label="Velocità della voce" value={s.voiceSpeed} onChange={(e) => save({ voiceSpeed: e.target.value as AppSettings['voiceSpeed'] })} className={select}>
                      <option value="lenta">Lenta</option><option value="normale">Normale</option><option value="veloce">Veloce</option>
                    </select>
                    <button type="button" onClick={() => {
                      tester.current ??= new Speaker();
                      tester.current.stop();
                      configureSpeaker(tester.current, { tts: s.ttsEngine, speed: s.voiceSpeed });
                      tester.current.unlock();
                      tester.current.say('Ciao, questa è la mia voce. Ti va bene così?');
                    }}
                      className="cc-press min-h-10 rounded-[10px] border border-line-hi px-3 text-[13.5px]">Prova</button>
                  </div>
                </Row>
              </>
            )}
          </Card>

          <Card id="progetti" open={open.has('progetti')} index={3} title="Progetti" intro="Ogni progetto è un repo git sul server. Per ciascuno: connettori di claude.ai e Companion (programmi del PC) per tutte le sue chat.">
            <div className="mb-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => props.onNewProject('new')} className="cc-press rounded-[10px] bg-acid px-3.5 py-2 text-[13px] font-semibold text-ink">+ Nuovo progetto</button>
              <button type="button" onClick={() => props.onNewProject('github')} className="cc-press rounded-[10px] border border-line-hi px-3.5 py-2 text-[13px]">Aggiungi da GitHub</button>
            </div>
            <label className="mb-3 flex min-h-10 items-center rounded-[10px] border border-line bg-ink px-3">
              <span className="sr-only">Cerca progetto</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca progetto…" className="w-full bg-transparent text-[14px] outline-none placeholder:text-muted" />
            </label>
            <div className="flex flex-col">
              <div className="mb-2 flex items-center justify-between gap-2 text-[12.5px] text-muted">
                <span>{props.agents.filter((a) => a.hidden).length} nascosti: non compaiono in dashboard, nell'elenco delle chat né nel riepilogo. Su GitHub e sul server non cambia niente.</span>
                <label className="flex flex-none items-center gap-2"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-[#A6FF00]" /> mostrali</label>
              </div>
              <div className="hidden grid-cols-[1fr_96px_96px_96px] gap-3 px-1 pb-2 text-[12px] text-muted sm:grid">
                <span>Progetto</span><span className="text-center">Visibile</span><span className="text-center">Connettori</span><span className="text-center">Companion</span>
              </div>
              {projects.map((a) => (
                <div key={a.id} className={`grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 border-t border-line/60 px-1 py-2.5 sm:grid-cols-[1fr_96px_96px_96px] ${a.hidden ? 'opacity-55' : ''}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[14px] font-medium">{a.name}</span>
                    <span className="truncate font-mono text-[11.5px] text-muted">{a.name !== a.id ? `${a.id} · ` : ''}{a.chats.length} chat</span>
                  </span>
                  <span className="flex items-center justify-end gap-2 sm:justify-center">
                    <span className="text-[12px] text-muted sm:hidden">Visibile</span>
                    <Switch on={!a.hidden} onChange={(v) => void api.setHidden(a.id, !v)} label={`${a.name} visibile in Ciccio`} />
                  </span>
                  <span className="col-start-2 flex items-center justify-end gap-2 sm:col-start-auto sm:justify-center">
                    <span className="text-[12px] text-muted sm:hidden">Connettori</span>
                    <Switch on={a.connectors} onChange={(v) => void api.setConnectors(a.id, v)} label={`Connettori per ${a.name}`} />
                  </span>
                  <span className="col-start-2 flex items-center justify-end gap-2 sm:col-start-auto sm:justify-center">
                    <span className="text-[12px] text-muted sm:hidden">Companion</span>
                    <Switch on={a.pcTools} onChange={(v) => void api.setPcTools(a.id, v)} label={`Companion per ${a.name}`} />
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card id="connettori" open={open.has('connettori')} index={4} title="Connettori di claude.ai"
            intro="Gmail, Calendar, Notion, Microsoft 365, i tuoi MCP: quelli del tuo account claude.ai, usati da Ciccio e dagli agenti.">
            <ConnectorsSection />
          </Card>

          <Card id="skill" open={open.has('skill')} index={5} title="Skill" intro="Pacchetti di istruzioni che insegnano a Claude a fare cose precise. Valgono per tutti gli agenti e, se acceso, per Ciccio.">
            <SkillsSection />
          </Card>

          <Card id="pc" open={open.has('pc')} index={6} title="Companion" intro="Ciccio Companion è il programma per Mac e Windows che fa usare agli agenti i programmi del PC acceso (Affinity, Chrome e gli altri MCP). Collegamento solo in uscita dal PC.">
            <PcToolsSection global enabled={null} onToggle={() => undefined} />
          </Card>

          <Card id="app" open={open.has('app')} index={6} title="App" intro="Ciccio in una finestra sua su Mac e Windows, con le notifiche del sistema: Consenti e Rifiuta direttamente dalla notifica.">
            <DesktopAppSection apps={props.desktopApps} />
          </Card>

          <Card id="credenziali" open={open.has('credenziali')} index={7} title="Credenziali" intro="Chiavi SSH e segreti di 1Password per gli agenti, presi dal tuo Mac o PC Windows quando serve: niente password in chat, niente chiavi sul server.">
            <CredentialsSection companions={props.companions} device={s?.onePasswordDevice ?? ''} onDevice={(id) => save({ onePasswordDevice: id })} />
          </Card>

          <Card id="accesso" open={open.has('accesso')} index={7} title="Accesso" intro="Si entra solo con una passkey, da qualunque rete. Ogni dispositivo ha la sua, e ogni indirizzo di Ciccio le sue: una passkey creata su un indirizzo non vale sugli altri.">
            <div className="flex flex-col">
              {passkeys?.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 border-t border-line/60 py-2.5 first:border-t-0">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[14px] font-medium">{p.name}</span>
                    <span className="text-[12px] text-muted">creata {timeAgo(p.createdAt)} fa</span>
                  </span>
                  <button type="button" onClick={() => { if (confirm(`Togliere la passkey "${p.name}"? Quel dispositivo non potrà più entrare finché non ne crei una nuova.`)) void api.removePasskey(p.id).then(loadPasskeys); }}
                    className="cc-press min-h-9 rounded-[8px] border border-line px-3 text-[13px] text-muted hover:border-block/50 hover:text-block">Togli</button>
                </div>
              ))}
              {passkeys?.length === 0 && <div className="text-[13px] text-muted">Nessuna passkey ancora: creala con un codice dal dispositivo che vuoi usare.</div>}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <AuthControls />
              <button type="button" onClick={() => { if (confirm('Uscire da tutti i dispositivi? Servirà di nuovo la passkey ovunque.')) void api.logoutAll().then(() => window.dispatchEvent(new Event('ciccio:auth'))); }}
                className="cc-press inline-flex items-center rounded-full border border-line px-3 py-1.5 text-[13px] text-muted hover:text-text">Esci da tutti i dispositivi</button>
            </div>
            {(props.setup.report?.origini.length ?? 0) > 1 && (
              <p className="m-0 mt-4 text-[12.5px] leading-relaxed text-muted">
                Indirizzi di Ciccio: {props.setup.report!.origini.map((o) => new URL(o).host).join(', ')}. Su ognuno crei la passkey a parte (con un codice da «Aggiungi dispositivo» aperto da quell'indirizzo).
              </p>
            )}
            {passkeys?.length === 1 && <p className="m-0 mt-3 text-[12.5px] leading-relaxed text-wait">Hai una sola passkey: se perdi quel dispositivo resti fuori. Aggiungine una su un altro. Per rientrare senza, sul server come utente di Ciccio: <code className="font-mono">bash deploy/install.sh code</code>.</p>}
            <div className="mt-5 mb-2 text-[13px] font-semibold">Sul telefono</div>
            <PhoneSteps />
          </Card>

          <Card id="server" open={open.has('server')} index={8} title="Server" intro="Il VPS dove girano Ciccio, gli agenti e la voce.">
            <ServerSection />
          </Card>

          <Card id="consumi" open={open.has('consumi')} index={9} title="Consumi" intro="Ciccio consuma token come Claude Code sul tuo PC, o di più? Stesso metro sui due lati, giorno per giorno: token pesati per ora di lavoro degli agenti.">
            <ConsumiSection />
          </Card>

          <Card id="uso" open={open.has('uso')} index={10} title="Uso di Claude"
            intro={props.usage?.auth === 'none' ? undefined : 'Abbonamento condiviso da Ciccio e da tutti gli agenti.'}>
            {props.usage?.auth === 'none' ? (
              <p className="m-0 max-w-[65ch] text-[13px] leading-relaxed text-block">Il server non ha il login di claude.ai: sul server, come utente di Ciccio, accedi con <code className="font-mono">claude auth login --claudeai</code> (il comando completo è in Configurazione › Accesso a Claude).</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <ClaudeUsage state={props.usage} />
              </div>
            )}
          </Card>
          <Card id="schermo" open={open.has('schermo')} index={11} title="Schermo" intro="Le misure di questo dispositivo come le vede la pagina, dal vivo. Servono a capire fasce vuote o barre spostate nell'app installata sul telefono.">
            <ScreenInfo />
          </Card>
          </DisclosureGroup>
        </main>
      </div>
    </div>
  );
}
