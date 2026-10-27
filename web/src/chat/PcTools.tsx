import { useEffect, useState, type ReactNode } from 'react';
import { NO_PACKAGE, api, timeAgo, useDownloads } from '../api';
import { Wizard } from '../Wizard';
import type { CompanionView } from '../../../shared/types';

// Companion: i PC collegati (Mac, PC Windows) con i loro server MCP,
// e il token per registrare un dispositivo nuovo (si vede una volta sola).

function useCompanions() {
  const [list, setList] = useState<CompanionView[] | null>(null);
  useEffect(() => {
    void api.companions().then(setList).catch(() => setList([]));
    const on = (e: Event) => setList((e as CustomEvent<CompanionView[]>).detail);
    window.addEventListener('ciccio:companions', on);
    return () => window.removeEventListener('ciccio:companions', on);
  }, []);
  return list;
}

// Il browser non sa su quale PC gira il companion: si ricorda quale dispositivo ha abbinato da qui.
const HERE_KEY = 'ciccio.companionHere';
function hereId(): string | null { try { return localStorage.getItem(HERE_KEY); } catch { return null; } }

/** Apre ciccio-companion://pair sul PC da cui si è premuto il pulsante, e se lo ricorda come «questo PC». */
function openPairLink(r: { device: CompanionView; token: string; server: string }) {
  try { localStorage.setItem(HERE_KEY, r.device.id); } catch { /* memoria non disponibile */ }
  location.href = `ciccio-companion://pair?token=${encodeURIComponent(r.token)}&server=${encodeURIComponent(r.server)}`;
}

function platformName(p: string | null) {
  if (!p) return '';
  if (p.startsWith('darwin')) return 'Mac';
  if (p.startsWith('win32')) return 'Windows';
  return p;
}

function Device({ c }: { c: CompanionView }) {
  const [confirm, setConfirm] = useState(false);
  const tools = c.servers.reduce((n, s) => n + (s.status === 'online' ? s.tools.length : 0), 0);
  const never = !c.online && c.lastSeen == null;
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className={`h-2 w-2 flex-none rounded-full ${c.online ? 'bg-done' : 'bg-line-hi'}`} />
        <span className="font-medium">{c.name}</span>
        {hereId() === c.id && <span className="flex-none rounded-full border border-line-hi px-2 py-0.5 text-[11px] text-soft" title="Abbinato da questo browser">questo PC</span>}
        <span className="truncate text-[12px] text-muted">
          {c.online ? `acceso · ${tools} strumenti` : never ? 'mai collegato' : `spento · visto ${timeAgo(c.lastSeen)}`}{c.platform ? ` · ${platformName(c.platform)}` : ''}
        </span>
        {c.online && c.notifications && (
          <span className="flex-none rounded-full border border-done/40 px-2 py-0.5 text-[11px] text-done" title="Gli avvisi di Ciccio arrivano su questo PC come notifiche del sistema">notifiche attive</span>
        )}
        {confirm
          ? <span className="ml-auto flex flex-none gap-1.5 text-[12px]">
              <button type="button" onClick={() => void api.removeCompanion(c.id)} className="rounded-[6px] bg-block/15 px-2 py-0.5 text-block hover:bg-block/25">Scollega</button>
              <button type="button" onClick={() => setConfirm(false)} className="rounded-[6px] px-2 py-0.5 text-muted hover:text-text">Annulla</button>
            </span>
          : <button type="button" onClick={() => setConfirm(true)} aria-label={`Scollega il dispositivo ${c.name}`} className="ml-auto flex-none text-[12px] text-muted hover:text-text">Scollega</button>}
      </div>
      {c.servers.map((s) => (
        <details key={s.name} className="group rounded-[8px] border border-line/70 px-2.5 py-1.5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-mono text-[12px]">
            <span className="truncate">{s.name}</span>
            <span className={s.status === 'online' ? 'text-done' : 'text-muted'}>{s.status === 'online' ? `${s.tools.length} strumenti` : 'non disponibile'}</span>
          </summary>
          {s.error && s.status !== 'online' && <div className="mt-1 text-[12px] leading-snug text-muted">{s.error}</div>}
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
            {s.tools.map((t) => (
              <li key={t.name} className="text-[12px] leading-snug">
                <span className="font-mono">{t.name}</span>
                {t.readOnly && <span className="text-muted"> · sola lettura</span>}
                {t.description && <div className="text-muted">{t.description}</div>}
              </li>
            ))}
          </ul>
        </details>
      ))}
      {c.online && !c.servers.length && <div className="text-[12px] text-muted">Nessun server MCP nella config del companion.</div>}
      {never ? <Repair c={c} /> : <ChromeWizard c={c} />}
    </div>
  );
}

/**
 * Dispositivo creato ma mai arrivato a Ciccio: il link di abbinamento non ha raggiunto il companion
 * (richiesta del browser rifiutata, programma non ancora installato…). Dal PC giusto si riprova:
 * token nuovo per lo stesso nome, quello di prima smette di valere.
 */
function Repair({ c }: { c: CompanionView }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const go = async () => {
    setErr(''); setBusy(true);
    try { openPairLink(await api.repairCompanion(c.id)); setSent(true); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-[8px] border border-wait/40 px-2.5 py-2 text-[12px] leading-snug text-muted">
      <span>«{c.name}» non si è mai collegato: l'abbinamento non è arrivato al programma sul PC. Dal PC che deve chiamarsi «{c.name}», con Ciccio Companion installato, premi qui e accetta le richieste del browser e del programma.</span>
      <button type="button" onClick={() => void go()} disabled={busy || !desktop}
        className="cc-press self-start rounded-[8px] bg-acid px-3 py-1.5 text-[12.5px] font-semibold text-ink disabled:opacity-40">{busy ? 'Un attimo…' : 'Collega questo PC'}</button>
      {!desktop && <span className="text-wait">Va fatto dal PC da collegare, non dal telefono.</span>}
      {sent && <span>Il browser chiede di aprire Ciccio Companion: accetta, poi «Collega» nella finestra. Se non compare niente, il programma non è installato su questo PC.</span>}
      {err && <span className="text-block">{err}</span>}
    </div>
  );
}

/**
 * Chrome per gli agenti, passo per passo: PC collegato, Chrome pronto (serve Node.js per avviarlo),
 * accesso ai siti nel profilo dedicato di Ciccio, prova finale. Il profilo è separato dal tuo Chrome
 * di tutti i giorni: gli agenti vedono solo i siti in cui entri lì.
 */
function ChromeWizard({ c }: { c: CompanionView }) {
  const chrome = c.servers.find((s) => s.name === 'chrome' || s.tools.some((t) => t.name === 'new_page'));
  const ready = !!chrome && chrome.status === 'online';
  const [url, setUrl] = useState('https://accounts.google.com');
  const [busy, setBusy] = useState<'' | 'open' | 'test'>('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [opened, setOpened] = useState(false);

  const act = async (action: 'open' | 'test') => {
    setBusy(action); setNote(null);
    try {
      const res = await fetch(`/api/companions/${encodeURIComponent(c.id)}/chrome`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, url }) });
      const data = await res.json() as { ok?: boolean; text?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Errore ${res.status}`);
      if (action === 'open') { setOpened(true); setNote({ ok: !!data.ok, text: data.ok ? 'Aperto sul PC: accedi al sito nella finestra di Chrome, poi torna qui.' : data.text ?? 'Non si è aperto.' }); }
      else {
        const pages = (data.text ?? '').split('\n').filter((l) => /^\s*\d+:/.test(l)).length;
        setNote({ ok: !!data.ok, text: data.ok ? `Chrome risponde${pages ? `: ${pages} ${pages === 1 ? 'scheda aperta' : 'schede aperte'}` : ''}. Gli agenti lo possono usare.` : data.text ?? 'Chrome non risponde.' });
      }
    } catch (e) { setNote({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(''); }
  };

  const Step = ({ n, done, title, children }: { n: number; done: boolean; title: string; children?: ReactNode }) => (
    <div className="flex gap-2.5">
      <span className={`flex h-5 w-5 flex-none items-center justify-center font-mono text-[11px] font-semibold ${done ? 'bg-acid text-ink' : 'border border-line-hi text-muted'}`}>{done ? '✓' : n}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className={`text-[13px] font-medium ${done ? 'text-soft' : 'text-text'}`}>{title}</span>
        {children}
      </div>
    </div>
  );

  return (
    <details className="rounded-[8px] border border-line/70 px-2.5 py-2" open={!ready}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[12.5px]">
        <span className="font-medium">Chrome per gli agenti</span>
        <span className={ready ? 'text-done' : 'text-wait'}>{ready ? 'pronto' : 'da collegare'}</span>
      </summary>
      <div className="mt-2.5 flex flex-col gap-3">
        <Step n={1} done={c.online} title={`Companion acceso su «${c.name}»`}>
          {!c.online && <span className="text-[12px] leading-snug text-muted">Apri Ciccio Companion sul PC: l'icona in alto a destra (Mac) o nell'area di notifica (Windows) diventa piena.</span>}
        </Step>
        <Step n={2} done={ready} title="Chrome pronto">
          {c.online && !ready && (
            <span className="cc-wrap text-[12px] leading-snug text-muted">
              {chrome?.error && /npx|ENOENT|not found|spawn/i.test(chrome.error)
                ? <>Serve Node.js sul PC per avviare Chrome per gli agenti: scaricalo da <a href="https://nodejs.org" target="_blank" rel="noreferrer" className="text-acid hover:underline">nodejs.org</a> (versione LTS), installalo e poi premi «Ricollega» nell'icona del companion.</>
                : chrome ? <>Chrome non risponde{chrome.error ? ` (${chrome.error})` : ''}. Premi «Ricollega» nell'icona del companion; se resta così, riavvia il PC.</>
                : <>Nella config del companion manca Chrome: aggiorna Ciccio Companion all'ultima versione.</>}
            </span>
          )}
          {ready && <span className="text-[12px] text-muted">Profilo dedicato, separato dal tuo Chrome di tutti i giorni · {chrome!.tools.length} strumenti.</span>}
        </Step>
        <Step n={3} done={opened} title="Accedi ai siti che servono agli agenti">
          <span className="text-[12px] leading-snug text-muted">Si apre il Chrome di Ciccio sul PC: entra con il tuo account nei siti che gli agenti devono usare (Google, gestionali…). Gli accessi restano salvati in quel profilo.</span>
          <div className="flex gap-1.5">
            <input value={url} onChange={(e) => setUrl(e.target.value)} disabled={!ready} aria-label="Sito da aprire" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              className="min-w-0 flex-1 rounded-[8px] border border-line bg-ink px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-acid disabled:opacity-50" />
            <button type="button" onClick={() => void act('open')} disabled={!ready || !!busy}
              className="cc-press flex-none rounded-[8px] bg-acid px-3 py-1.5 text-[12.5px] font-semibold text-ink disabled:opacity-40">{busy === 'open' ? 'Apro…' : 'Apri sul PC'}</button>
          </div>
        </Step>
        <Step n={4} done={!!note?.ok && !busy && note.text.startsWith('Chrome risponde')} title="Prova">
          <button type="button" onClick={() => void act('test')} disabled={!ready || !!busy}
            className="cc-press self-start rounded-[8px] border border-line-hi px-3 py-1.5 text-[12.5px] disabled:opacity-40">{busy === 'test' ? 'Provo…' : 'Prova Chrome'}</button>
        </Step>
        {note && <div className={`cc-wrap text-[12px] leading-snug ${note.ok ? 'text-done' : 'text-block'}`}>{note.text}</div>}
      </div>
    </details>
  );
}

type Desktop = 'mac' | 'windows';
const desktop: Desktop | null = typeof navigator === 'undefined' || /iPhone|iPad|Android/.test(navigator.userAgent) ? null
  : /Mac/.test(navigator.platform || navigator.userAgent) ? 'mac'
  : /Win/.test(navigator.platform || navigator.userAgent) ? 'windows' : null;

const SETUP: Record<Desktop, { name: string; label: string; download: string; install: string; sent: string; idle: string }> = {
  mac: {
    name: 'mac', label: 'Mac', download: '/download/CiccioCompanion-mac.dmg',
    install: "Apri il file, trascina l'app in Applicazioni e aprila. La prima volta macOS la blocca: Impostazioni di Sistema › Privacy e sicurezza › «Apri comunque».",
    sent: "Conferma «Collega» nella finestra di Ciccio Companion: l'icona in alto a destra diventa piena quando è collegato.",
    idle: "Con l'app già aperta: il Mac compare qui sopra appena è collegato.",
  },
  windows: {
    name: 'windows', label: 'PC', download: '/download/CiccioCompanion-windows.exe',
    install: "Aprilo con un doppio clic: si installa da solo nella tua cartella utente, senza amministratore, e compare l'icona di Ciccio nell'area di notifica. SmartScreen lo blocca perché non è firmato: «Ulteriori informazioni» › «Esegui comunque».",
    sent: 'Il browser chiede di aprire Ciccio Companion: accetta, poi «Collega» nella finestra. L\'icona di Ciccio in basso a destra diventa piena quando è collegato.',
    idle: 'Dopo averlo installato: il PC compare qui sopra appena è collegato, e resta acceso in background a ogni accesso.',
  },
};

/**
 * Collega un PC, passo per passo: quale PC, scarica, installa, collega, fatto (si accorge da solo
 * quando il PC si presenta). Dal telefono spiega che va fatto dal PC da collegare.
 */
function PcWizard({ list, onClose }: { list: CompanionView[]; onClose?: () => void }) {
  const [os, setOs] = useState<Desktop>(desktop ?? 'mac');
  const [name, setName] = useState(desktop === 'windows' ? 'windows' : 'mac');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const t = SETUP[os];
  const downloads = useDownloads();
  const here = desktop === os;
  const linked = deviceId ? list.find((c) => c.id === deviceId) : undefined;
  // Dopo 15 secondi senza che il PC si presenti: il link non è arrivato al programma.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!sent || linked?.online) { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), 15_000);
    return () => clearTimeout(t);
  }, [sent, linked?.online]);
  const pair = async () => {
    setErr(''); setBusy(true); setSent(false);
    try {
      // Stesso nome di un dispositivo mai collegato: Ciccio riusa quello con un token nuovo.
      const r = await api.createCompanion(name);
      setDeviceId(r.device.id);
      openPairLink(r);
      setSent(true);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const btn = (on: boolean) => `cc-press flex-1 rounded-[10px] border px-3 py-2.5 text-left ${on ? 'border-acid/70 bg-acid/[.06]' : 'border-line hover:border-line-hi'}`;
  return (
    <Wizard onDone={onClose} doneLabel="Chiudi" steps={[
      {
        title: 'Quale PC',
        body: (
          <>
            <p className="m-0">Ciccio Companion fa usare agli agenti i programmi di un tuo PC (Affinity, Chrome): il PC apre un collegamento verso Ciccio, senza porte aperte, e ogni azione passa dai permessi della chat.</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => { setOs('mac'); setName('mac'); }} className={btn(os === 'mac')}><span className="block text-[14px] font-medium">Mac</span><span className="text-[12px] text-muted">macOS 13 o più recente</span></button>
              <button type="button" onClick={() => { setOs('windows'); setName('windows'); }} className={btn(os === 'windows')}><span className="block text-[14px] font-medium">Windows</span><span className="text-[12px] text-muted">Windows 10 o 11</span></button>
            </div>
            {!here && <p className="m-0 text-[12.5px] text-wait">Il collegamento va fatto dal PC stesso: apri {location.host} su quel PC e rifai questi passi da lì.</p>}
          </>
        ),
      },
      {
        title: 'Scarica',
        body: (
          <>
            <p className="m-0">Scarica il programma per {os === 'mac' ? 'Mac' : 'Windows'}: un file solo, niente da configurare.</p>
            {!downloads || downloads.has(t.download.replace(/^.*\//, ''))
              ? <a href={t.download} className="cc-press self-start rounded-[10px] bg-acid px-4 py-2 text-[13.5px] font-semibold text-ink">Scarica Ciccio Companion</a>
              : <p className="m-0 text-[12.5px] text-wait">{NO_PACKAGE}</p>}
          </>
        ),
        next: "L'ho scaricato",
      },
      {
        title: 'Installa',
        body: (
          <>
            <p className="m-0">{t.install}</p>
            <p className="m-0 text-[12.5px] text-muted">Il blocco della prima apertura c'è perché il programma non ha ancora la firma di Apple o Microsoft: succede una volta sola.</p>
          </>
        ),
        next: "È aperto",
      },
      {
        title: 'Collega',
        canNext: !!linked?.online,
        next: 'Avanti',
        body: (
          <>
            <p className="m-0">Dai un nome a questo PC e collegalo: il programma ti chiede conferma e accetta solo {location.host}.</p>
            <div className="flex gap-2">
              <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16))} aria-label="Nome del PC"
                className="w-28 min-w-0 rounded-[10px] border border-line bg-transparent px-3 py-2 text-[13.5px] outline-none focus:border-acid" />
              <button type="button" onClick={() => void pair()} disabled={!name || busy || !here}
                className="cc-press flex-none rounded-[10px] bg-acid px-4 py-2 text-[13.5px] font-semibold text-ink disabled:opacity-40">Collega questo {t.label}</button>
            </div>
            {sent && !linked?.online && <p className="m-0 text-[12.5px] text-muted">{t.sent} Aspetto che si presenti…</p>}
            {slow && !linked?.online && (
              <p className="m-0 text-[12.5px] text-wait">
                Ancora niente: il programma non ha ricevuto il collegamento. Controlla che Ciccio Companion sia installato su questo PC
                e che tu abbia accettato «Apri Ciccio Companion» nel browser e «Collega» nella sua finestra, poi premi di nuovo «Collega questo {t.label}» (stesso nome, va bene).
              </p>
            )}
            {linked?.online && <p className="m-0 text-[13px] font-medium text-done">Collegato: «{linked.name}» è acceso.</p>}
            {!here && <p className="m-0 text-[12.5px] text-wait">Questo pulsante funziona solo dal PC da collegare.</p>}
            {err && <p className="m-0 text-[12.5px] text-block">{err}</p>}
          </>
        ),
      },
      {
        title: 'Fatto',
        body: (
          <>
            <p className="m-0 font-medium text-text">«{linked?.name ?? name}» è collegato{linked ? ` con ${linked.servers.filter((x) => x.status === 'online').map((x) => x.name).join(', ') || 'nessun programma ancora pronto'}` : ''}.</p>
            <p className="m-0">Gli agenti vedono i suoi strumenti dal prossimo messaggio. Se vuoi che usino Chrome, apri «Chrome per gli agenti» nella scheda del PC qui sopra: ti guida ad accedere ai siti che servono.</p>
          </>
        ),
      },
    ]} />
  );
}

/**
 * Il programma installato non è nel PATH: il comando usa il percorso vero, diverso su Mac (dentro l'app)
 * e su Windows (cartella utente, sintassi di PowerShell).
 */
const CLI: Record<Desktop, { cmd: string; where: string }> = {
  mac: { cmd: '"/Applications/Ciccio Companion.app/Contents/Resources/ciccio-companion"', where: 'nel Terminale del Mac' },
  windows: { cmd: '& "$env:USERPROFILE\\.ciccio-companion\\bin\\ciccio-companion.exe"', where: 'in PowerShell sul PC' },
};

function NewDevice() {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [made, setMade] = useState<{ name: string; token: string; server: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [os, setOs] = useState<Desktop>(desktop ?? 'mac');
  if (made) {
    const cmd = `${CLI[os].cmd} init ${made.token} --server ${made.server}`;
    const tab = (o: Desktop, label: string) => (
      <button type="button" onClick={() => { setOs(o); setCopied(false); }} aria-pressed={os === o}
        className={`rounded-[6px] px-2 py-0.5 text-[12px] ${os === o ? 'bg-line text-text' : 'text-muted hover:text-text'}`}>{label}</button>
    );
    return (
      <div className="flex flex-col gap-2 rounded-[10px] border border-acid/60 bg-acid/[.05] px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">Token per «{made.name}»</span>
          <span className="flex gap-1">{tab('mac', 'Mac')}{tab('windows', 'Windows')}</span>
        </div>
        <div className="text-[12px] leading-snug text-muted">Con Ciccio Companion già installato, lancia questo comando {CLI[os].where}: salva il token e ricollega il companion acceso. Il token si vede solo adesso: in Ciccio resta solo la sua impronta.</div>
        <code className="block break-all rounded-[6px] border border-line bg-panel-hi px-2 py-1.5 font-mono text-[11.5px]">{cmd}</code>
        <div className="flex gap-2">
          <button type="button" onClick={() => void navigator.clipboard.writeText(cmd).then(() => setCopied(true))}
            className="cc-press rounded-[8px] bg-acid px-3 py-1.5 text-[12.5px] font-semibold text-ink">{copied ? 'Copiato' : 'Copia comando'}</button>
          <button type="button" onClick={() => { setMade(null); setCopied(false); }} className="rounded-[8px] px-3 py-1.5 text-[12.5px] text-muted hover:text-text">Fatto</button>
        </div>
      </div>
    );
  }
  const create = () => {
    setErr('');
    void api.createCompanion(name).then((r) => { setMade({ name: r.device.name, token: r.token, server: r.server }); setName(''); }).catch((e: Error) => setErr(e.message));
  };
  return (
    <form className="flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); create(); }}>
      <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16))} placeholder="nome, es. mac o windows"
          aria-label="Nome del nuovo dispositivo"
          className="min-w-0 flex-1 rounded-[8px] border border-line bg-transparent px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted focus:border-line-hi" />
        <button type="submit" disabled={!name} className="cc-press flex-none rounded-[8px] bg-acid px-3 py-1.5 text-[12.5px] font-semibold text-ink disabled:opacity-40">Genera token</button>
      </div>
      {err && <div className="text-[12px] text-block">{err}</div>}
    </form>
  );
}

/** Nelle impostazioni di una chat ha l'interruttore del progetto; nella pagina Impostazioni (global) solo i PC. */
export function PcToolsSection({ enabled, onToggle, global = false }: { enabled: boolean | null; onToggle: (on: boolean) => void; global?: boolean }) {
  const list = useCompanions();
  const [wizard, setWizard] = useState(false);
  return (
    <section className="flex flex-col gap-2">
      <div className={`flex items-center justify-between gap-3 ${global ? 'hidden' : ''}`}>
        <h2 className="m-0 text-[13px] font-semibold">Companion <span className="font-normal text-muted">· programmi del PC, tutto il progetto</span></h2>
        <button type="button" role="switch" aria-checked={!!enabled} aria-label={enabled ? 'Spegni il Companion per questo progetto' : 'Accendi il Companion per questo progetto'}
          disabled={enabled == null} onClick={() => enabled != null && onToggle(!enabled)}
          className={`relative h-[22px] w-[38px] flex-none rounded-full transition-colors duration-150 ${enabled ? 'bg-acid' : 'bg-line-hi'}`}>
          <span className={`absolute top-[3px] h-4 w-4 rounded-full transition-[left] duration-150 ${enabled ? 'left-[19px] bg-ink' : 'left-[3px] bg-soft'}`} />
        </button>
      </div>
      <div className="text-[12px] leading-snug text-muted">
        Affinity, Chrome e gli altri MCP del PC acceso adesso, tramite il companion (collegamento in uscita dal PC, nessuna porta aperta).
        Passano dagli stessi livelli di autorizzazione della chat. Valgono dal prossimo messaggio.
      </div>
      {list == null ? null : list.length
        ? <div className="flex flex-col gap-1.5">{list.map((c) => <Device key={c.id} c={c} />)}</div>
        : null}
      {list != null && (wizard || !list.length
        ? <PcWizard list={list} onClose={list.length ? () => setWizard(false) : undefined} />
        : <button type="button" onClick={() => setWizard(true)} className="cc-press self-start rounded-[10px] border border-dashed border-acid/60 px-3.5 py-2 text-[13px] font-medium text-acid hover:bg-acid/[.06]">+ Collega un altro PC</button>)}
      <details className="text-[12px] text-muted">
        <summary className="cursor-pointer">Avanzato: collega da terminale con un token</summary>
        <div className="mt-2"><NewDevice /></div>
      </details>
    </section>
  );
}
