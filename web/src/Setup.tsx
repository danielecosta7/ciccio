import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Wizard, type WizardStep } from './Wizard';
import { PixelMark } from './ui';
import { ownerNameError, rootStep, sshHostError, type GithubLoginState, type SetupItem, type SetupReport, type SetupState } from '../../shared/setup';

// Configurazione guidata: cosa manca sul server e come sistemarlo, un passo alla volta.
// Prima sezione delle Impostazioni e pagina /configurazione, aperta da sola al primo accesso se manca qualcosa.

async function json<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) window.dispatchEvent(new Event('ciccio:auth'));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Errore ${res.status}`);
  return data as T;
}

/** Stato della configurazione: si legge all'avvio e quando lo chiedi (fresh salta i 30 secondi di cache del server). */
export function useSetup() {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async (fresh = false) => {
    setBusy(true);
    try { setReport(await json<SetupReport>(`/api/setup${fresh ? '?fresh=1' : ''}`)); } catch { /* resta l'ultimo */ } finally { setBusy(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { report, busy, reload };
}
export type SetupHook = ReturnType<typeof useSetup>;

const STATE: Record<SetupState, { label: string; dot: string; text: string }> = {
  manca: { label: 'da fare', dot: 'bg-block', text: 'text-block' },
  avviso: { label: 'da guardare', dot: 'bg-wait', text: 'text-wait' },
  facoltativo: { label: 'in più', dot: 'bg-line-hi', text: 'text-muted' },
  ok: { label: 'a posto', dot: 'bg-done', text: 'text-done' },
};

/** Testo da copiare con un tocco (comandi, indirizzi). */
export function CopyLine({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); } catch {
      // Senza permesso agli appunti: la vecchia strada.
      const t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch { /* resta da selezionare a mano */ }
      t.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <div className="flex min-w-0 items-stretch gap-2">
      <code className="cc-selectable flex min-h-10 min-w-0 flex-1 items-center rounded-[10px] border border-line bg-ink px-3 py-2 font-mono text-[12.5px] text-soft">{text}</code>
      <button type="button" onClick={() => void copy()} aria-label={label ?? 'Copia'}
        className="cc-press min-h-10 flex-none rounded-[10px] border border-line-hi px-3 text-[13px]">{done ? 'Copiato' : 'Copia'}</button>
    </div>
  );
}

const input = 'min-w-0 flex-1 rounded-[10px] border border-line bg-ink px-3 py-2 text-[14px] outline-none focus:border-acid';
const primary = 'cc-press flex-none rounded-[10px] bg-acid px-4 py-2 text-[13.5px] font-semibold text-ink disabled:opacity-40';
const secondary = 'cc-press self-start rounded-[10px] border border-line-hi px-3.5 py-2 text-[13px]';

// ── Passi fatti da qui ──────────────────────────────────────────────────

function GithubLogin({ onDone }: { onDone: () => void }) {
  const [s, setS] = useState<GithubLoginState>({ state: 'idle' });
  const [error, setError] = useState('');
  useEffect(() => { void json<GithubLoginState>('/api/setup/github').then(setS).catch(() => undefined); }, []);
  // Mentre aspetta la conferma su github.com: si chiede a che punto è ogni 2 secondi.
  useEffect(() => {
    if (s.state !== 'waiting') return undefined;
    const t = setInterval(() => void json<GithubLoginState>('/api/setup/github').then((n) => { setS(n); if (n.state === 'done') onDone(); }).catch(() => undefined), 2000);
    return () => clearInterval(t);
  }, [s.state, onDone]);
  const start = () => { setError(''); void json<GithubLoginState>('/api/setup/github', {}).then(setS).catch((e: Error) => setError(e.message)); };
  const cancel = () => void json<GithubLoginState>('/api/setup/github/cancel', {}).then(setS).catch(() => undefined);
  return (
    <>
      {s.state === 'idle' && (
        <>
          <p className="m-0">Il server chiede a GitHub un codice monouso. Tu lo scrivi su github.com dal telefono o dal PC e confermi: gh resta collegato al tuo account, con git in https.</p>
          <button type="button" onClick={start} className={`${primary} self-start`}>Chiedi il codice</button>
        </>
      )}
      {s.state === 'waiting' && (
        <>
          {s.code ? (
            <>
              <p className="m-0">Apri il link, accedi a GitHub e scrivi questo codice:</p>
              <span className="cc-selectable self-start font-mono text-[24px] tracking-[0.12em] text-acid">{s.code}</span>
              <div className="flex flex-wrap gap-2">
                <a href={s.url ?? 'https://github.com/login/device'} target="_blank" rel="noreferrer" className={primary}>Apri github.com/login/device</a>
                <button type="button" onClick={cancel} className={secondary}>Annulla</button>
              </div>
              <p className="m-0 text-[12.5px] text-muted">Aspetto la conferma: questa pagina se ne accorge da sola. Il codice vale 15 minuti.</p>
            </>
          ) : <p className="m-0 text-muted">Chiedo il codice a GitHub…</p>}
        </>
      )}
      {s.state === 'done' && <p className="m-0 font-medium text-done">Collegato a GitHub{s.login ? ` come ${s.login}` : ''}, git usa le stesse credenziali.</p>}
      {s.state === 'error' && (
        <>
          <p className="cc-wrap m-0 text-[12.5px] text-block">{s.error}</p>
          <button type="button" onClick={start} className={secondary}>Riprova</button>
        </>
      )}
      {error && <p className="cc-wrap m-0 text-[12.5px] text-block">{error}</p>}
    </>
  );
}

function GitIdentityForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void json<{ name: string; email: string; suggested: { name: string; email: string } | null }>('/api/setup/git').then((r) => {
      setName(r.name || r.suggested?.name || '');
      setEmail(r.email || r.suggested?.email || '');
    }).catch(() => undefined);
  }, []);
  const save = async () => {
    setBusy(true); setNote(null);
    try { await json('/api/setup/git', { name, email }); setNote({ ok: true, text: 'Salvato: i prossimi commit degli agenti escono con questo nome.' }); onSaved(); }
    catch (e) { setNote({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); }
  };
  return (
    <>
      <p className="m-0">Nome ed email dei commit degli agenti (git config --global). Con GitHub collegato te li propongo dal tuo account; l'email noreply di GitHub tiene privata la tua.</p>
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome" aria-label="Nome per git" className={input} />
        <div className="flex gap-2">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" type="email" aria-label="Email per git" autoCapitalize="none" className={input} />
          <button type="submit" disabled={busy || !name.trim() || !email.includes('@')} className={primary}>{busy ? 'Salvo…' : 'Salva'}</button>
        </div>
      </form>
      {note && <p className={`cc-wrap m-0 text-[12.5px] ${note.ok ? 'text-done' : 'text-block'}`}>{note.text}</p>}
    </>
  );
}

function RestartButton() {
  const [state, setState] = useState<'idle' | 'busy' | 'systemd' | 'manuale'>('idle');
  return state === 'systemd' ? <p className="m-0 text-[12.5px] text-done">Ciccio si riavvia tra pochi secondi: la pagina si ricollega da sola.</p>
    : state === 'manuale' ? <><p className="m-0 text-[12.5px] text-muted">Ciccio non gira con systemd qui: riavvialo tu.</p><CopyLine text="systemctl --user restart ciccio" /></>
      : <button type="button" disabled={state === 'busy'} className={secondary}
          onClick={() => { if (!confirm('Riavviare Ciccio adesso? I giri al lavoro hanno qualche secondo per finire, poi riprendono da soli.')) return; setState('busy'); void json<{ restart: 'systemd' | 'manuale' }>('/api/setup/restart', {}).then((r) => setState(r.restart)).catch(() => setState('idle')); }}>
          Riavvia Ciccio adesso
        </button>;
}

function OwnerForm({ onSaved }: { onSaved: () => void }) {
  const [info, setInfo] = useState<{ active: string; saved: string | null; fallback: string } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void json<{ active: string; saved: string | null; fallback: string }>('/api/setup/owner').then((r) => { setInfo(r); setName(r.saved ?? r.active); }).catch(() => undefined); }, []);
  const problem = ownerNameError(name);
  const save = async () => {
    setBusy(true); setError('');
    try { const r = await json<{ active: string; saved: string }>('/api/setup/owner', { name }); setInfo((i) => (i ? { ...i, ...r } : i)); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const pending = info?.saved && info.saved !== info.active;
  return (
    <>
      <p className="m-0">Ciccio e gli agenti ti chiamano così nei messaggi e nei riepiloghi. Il nome di partenza viene da CICCIO_OWNER_NAME{info ? ` (${info.fallback})` : ''}.</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Il tuo nome" aria-label="Il tuo nome" maxLength={40} className={input} />
        <button type="submit" disabled={busy || !!problem || name.trim() === (info?.saved ?? info?.active)} className={primary}>{busy ? 'Salvo…' : 'Salva'}</button>
      </form>
      {name.trim() && problem && <p className="m-0 text-[12.5px] text-block">{problem}</p>}
      {error && <p className="m-0 text-[12.5px] text-block">{error}</p>}
      {pending && (
        <>
          <p className="m-0 text-[12.5px] text-wait">«{info.saved}» vale dal prossimo riavvio: i prompt degli agenti si preparano all'avvio. Adesso ti chiamano {info.active}.</p>
          <RestartButton />
        </>
      )}
    </>
  );
}

/** Server raggiungibili in SSH dagli agenti: elenco, aggiunta e rimozione con l'helper root ciccio-ssh-allow. */
export function SshHostsEditor({ onChange }: { onChange?: () => void }) {
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void json<{ hosts: string[] }>('/api/setup/ssh-hosts').then((r) => setHosts(r.hosts)).catch(() => setHosts([])); }, []);
  const problem = host.trim() ? sshHostError(host) : null;
  const act = async (action: 'add' | 'remove', h: string) => {
    if (action === 'remove' && !confirm(`Togliere ${h}? Gli agenti non potranno più collegarsi in SSH a quel server.`)) return;
    setBusy(h); setError('');
    try {
      const r = await json<{ hosts: string[] }>('/api/setup/ssh-hosts', { action, host: h });
      setHosts(r.hosts);
      if (action === 'add') setHost('');
      onChange?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  return (
    <div className="flex flex-col gap-2">
      {hosts == null ? <div className="text-[13px] text-muted">Carico…</div>
        : hosts.length === 0 ? <div className="text-[13px] text-muted">Nessuno: il firewall del server blocca ogni SSH in uscita degli agenti.</div>
          : (
            <div className="flex flex-wrap gap-1.5">
              {hosts.map((h) => (
                <span key={h} className="flex items-center gap-1 rounded-[6px] border border-line bg-panel-hi py-0.5 pr-0.5 pl-2 font-mono text-[12px]">
                  {h}
                  <button type="button" disabled={busy === h} onClick={() => void act('remove', h)} aria-label={`Togli ${h}`}
                    className="cc-press flex h-6 w-6 items-center justify-center rounded-[4px] text-muted hover:text-block disabled:opacity-40">×</button>
                </span>
              ))}
            </div>
          )}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!problem) void act('add', host.trim()); }}>
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="server.example.com:22" aria-label="Server SSH da aggiungere" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          className={`${input} font-mono text-[12.5px]`} />
        <button type="submit" disabled={!host.trim() || !!problem || busy != null} className={primary}>{busy === host.trim() ? 'Aggiungo…' : 'Aggiungi server'}</button>
      </form>
      {problem && <p className="m-0 text-[12.5px] text-block">{problem}</p>}
      {error && <p className="cc-wrap m-0 text-[12.5px] text-block">{error}</p>}
      <p className="m-0 text-[12.5px] leading-relaxed text-muted">Aggiungerne uno apre il firewall del server verso quell'host e quella porta (22 se non la scrivi). Lo fa l'helper ciccio-ssh-allow, che rifà da sé tutti i controlli.</p>
    </div>
  );
}

// ── Passi per voce ──────────────────────────────────────────────────────

/** Dove portano le voci da sistemare nelle Impostazioni. */
const SECTION_LABEL: Record<string, string> = { pc: 'Companion', app: 'App', credenziali: 'Credenziali', accesso: 'Accesso', progetti: 'Progetti' };

const WHY: Record<string, string> = {
  claude: 'Ciccio e gli agenti lavorano con Claude Code attraverso l\'Agent SDK, con il login del tuo abbonamento claude.ai (Pro, Max, Team o Enterprise) fatto sul server.',
  tailscale: 'Tailscale mette il server nella tua rete privata: Ciccio non è esposto su internet e lo apri da telefono e PC collegati alla tailnet.',
  serve: 'tailscale serve dà a Ciccio un indirizzo https con un certificato vero: le passkey funzionano solo in https.',
  linger: 'Ciccio gira come servizio del tuo utente: con linger parte all\'accensione del server anche senza nessuno collegato.',
  sandbox: 'I comandi degli agenti girano in una sandbox (bubblewrap): scrivono solo nel repo del progetto. socat serve per SSH attraverso il proxy.',
  firewall: 'Gli agenti escono su internet solo da un proxy con l\'elenco dei domini consentiti; ufw blocca tutto il resto.',
  helper: 'Tre piccoli comandi root che Ciccio può lanciare senza password, ognuno per una cosa sola e con i suoi controlli: aprire un dominio, installare un pacchetto ufficiale, aprire SSH verso un server.',
  github: 'Con gh collegato Ciccio crea i repo dei progetti nuovi e importa quelli esistenti; git usa le stesse credenziali.',
  git: 'Gli agenti fanno commit con questo nome ed email.',
  passkey: 'Si entra in Ciccio solo con una passkey, da qualunque rete.',
  nome: 'Il nome con cui Ciccio e gli agenti ti parlano.',
  progetti: 'Ogni progetto è un repo git sul server, con le sue chat.',
  fuso: 'Il fuso per gli orari di routine e riepilogo.',
  ssh: 'Gli agenti si collegano in SSH solo ai server di questo elenco, con le tue chiavi di 1Password.',
  companion: 'Il companion fa usare agli agenti i programmi del tuo Mac o PC Windows acceso.',
  app: 'Ciccio in una finestra sua, con le notifiche del sistema.',
  onepassword: 'Chiavi SSH e segreti arrivano da 1Password sul PC con il companion: servono l\'agent SSH e la CLI op.',
  voce: 'Trascrizione (Whisper) e voce di Ciccio (Piper) sul server: niente audio a terzi.',
  dominio: 'Un dominio tuo con Caddy apre Ciccio anche fuori dalla tailnet, sempre con le passkey.',
};

function rootSteps(item: SetupItem): WizardStep[] {
  return [
    { title: 'Cosa serve', body: <><p className="m-0">{WHY[item.id] ?? item.dettaglio}</p><p className="m-0 text-muted">{item.dettaglio}</p></> },
    {
      title: 'Sul server',
      body: (
        <>
          <p className="m-0">Serve root: entra nel server in SSH con un utente che ha sudo, vai nella cartella di Ciccio (di solito ~/ciccio dell'utente di Ciccio) e lancia:</p>
          <CopyLine text={item.rimedio.comando ?? ''} />
          <p className="m-0 text-[12.5px] text-muted">Quando ha finito, torna qui e premi Ricontrolla.</p>
        </>
      ),
      next: 'Fatto',
    },
  ];
}

function PasskeyHelp({ origins, onGo }: { origins: string[]; onGo?: (section: string) => void }) {
  return (
    <>
      <p className="m-0">Ogni dispositivo ha la sua passkey. Tienine almeno due (telefono e PC): se ne perdi uno entri dall'altro e togli quella persa.</p>
      {origins.length > 1 && <p className="m-0">Ogni indirizzo vuole le sue passkey: {origins.map((o) => new URL(o).host).join(', ')}. Una passkey creata su uno non vale sull'altro.</p>}
      <p className="m-0 text-muted">Chiuso fuori? Sul server, come utente di Ciccio, <code className="font-mono">bash deploy/install.sh code</code> stampa un codice di attivazione per una passkey nuova.</p>
      {onGo && <button type="button" onClick={() => onGo('accesso')} className={secondary}>Apri Impostazioni › Accesso</button>}
    </>
  );
}

function itemSteps(item: SetupItem, ctx: { recheck: () => void; onGo?: (section: string) => void; origins: string[] }): WizardStep[] {
  const why = WHY[item.id];
  const intro: WizardStep = { title: 'Cosa serve', body: <>{why && <p className="m-0">{why}</p>}<p className="m-0 text-muted">{item.dettaglio}</p></> };
  if (item.rimedio.tipo === 'root') return rootSteps(item);
  switch (item.id) {
    case 'github':
      return [intro, { title: 'Accedi', body: <GithubLogin onDone={ctx.recheck} /> }];
    case 'git':
      return [{ title: 'Nome ed email', body: <GitIdentityForm onSaved={ctx.recheck} /> }];
    case 'nome':
      return [{ title: 'Il tuo nome', body: <OwnerForm onSaved={ctx.recheck} /> }];
    case 'ssh':
      return [{ title: 'Server SSH', body: <><p className="m-0">{why}</p><SshHostsEditor onChange={ctx.recheck} /></> }];
    case 'passkey':
      return [intro, { title: 'Più dispositivi', body: <PasskeyHelp origins={ctx.origins} onGo={ctx.onGo} /> }, { title: 'Sul telefono', body: <PhoneSteps /> }];
    default: {
      const steps: WizardStep[] = [intro];
      if (item.rimedio.comando) {
        steps.push({
          title: 'Comando',
          body: (
            <>
              <p className="m-0">Sul server, come utente di Ciccio{item.rimedio.comando.startsWith('pnpm') ? ', dalla cartella del repo sul tuo PC (pubblica i pacchetti nella cartella downloads del server)' : ''}:</p>
              <CopyLine text={item.rimedio.comando} />
            </>
          ),
        });
      }
      const sec = item.rimedio.sezione;
      if (sec && SECTION_LABEL[sec] && ctx.onGo) {
        steps.push({ title: 'Dove', body: <><p className="m-0">Si fa da Impostazioni › {SECTION_LABEL[sec]}.</p><button type="button" onClick={() => ctx.onGo!(sec)} className={secondary}>Apri {SECTION_LABEL[sec]}</button></> });
      }
      return steps;
    }
  }
}

/** Passi per mettere Ciccio sulla schermata Home del telefono, come un'app. */
export function PhoneSteps() {
  return (
    <div className="flex flex-col gap-2 text-[13.5px] leading-relaxed text-soft">
      <div><b className="text-text">iPhone e iPad (Safari).</b> Apri Ciccio, tocca Condividi (il quadrato con la freccia), poi «Aggiungi alla schermata Home» e «Aggiungi». Aprilo dall'icona: la passkey usa Face ID.</div>
      <div><b className="text-text">Android (Chrome).</b> Apri Ciccio, tocca il menu ⋮, poi «Aggiungi a schermata Home» (o «Installa app») e conferma. La passkey usa l'impronta o il blocco schermo.</div>
      <div className="text-muted">La prima volta dal telefono serve un codice: generalo da un dispositivo già dentro con «Aggiungi dispositivo».</div>
    </div>
  );
}

function ItemRow({ item, open, onToggle, ctx }: { item: SetupItem; open: boolean; onToggle: () => void; ctx: { recheck: () => void; onGo?: (section: string) => void; origins: string[] } }) {
  const st = STATE[item.stato];
  return (
    <div className="border-t border-line/60 first:border-t-0">
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex w-full items-start gap-3 py-3 text-left">
        <span className={`mt-[7px] h-2 w-2 flex-none ${st.dot}`} aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[14px] font-medium">{item.titolo}</span>
            <span className={`text-[12px] ${st.text}`}>{st.label}</span>
          </span>
          <span className="cc-wrap text-[12.5px] leading-snug text-muted">{item.dettaglio}</span>
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          className={`mt-1 flex-none text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="pb-4">
              <Wizard key={item.id} steps={itemSteps(item, ctx)} onDone={ctx.recheck} doneLabel="Ricontrolla" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const ORDER: SetupState[] = ['manca', 'avviso', 'facoltativo', 'ok'];
const GROUP: Record<SetupState, string> = { manca: 'Da fare', avviso: 'Da guardare', facoltativo: 'In più', ok: 'A posto' };

/** Elenco delle voci, raggruppate per stato; ognuna si apre nel suo wizard. */
export function SetupChecklist({ setup, onGo }: { setup: SetupHook; onGo?: (section: string) => void }) {
  const { report, busy, reload } = setup;
  const [open, setOpen] = useState<string | null>(null);
  const [showOk, setShowOk] = useState(false);
  // Apre da sola la prima voce da fare, una volta.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !report) return;
    opened.current = true;
    const first = report.items.find((i) => i.stato === 'manca');
    if (first) setOpen(first.id);
  }, [report]);
  if (!report) return <div className="text-[13px] text-muted">{busy ? 'Controllo il server…' : 'Configurazione non disponibile.'}</div>;
  const ctx = { recheck: () => void reload(true), onGo, origins: report.origini };
  const counts = Object.fromEntries(ORDER.map((s) => [s, report.items.filter((i) => i.stato === s).length])) as Record<SetupState, number>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={`text-[14px] font-medium ${report.mancano ? 'text-block' : 'text-done'}`}>
          {report.mancano ? `${report.mancano} ${report.mancano === 1 ? 'passo da fare' : 'passi da fare'}` : 'Tutto quello che serve è a posto'}
          {counts.avviso > 0 && <span className="font-normal text-wait"> · {counts.avviso} da guardare</span>}
        </span>
        <button type="button" disabled={busy} onClick={() => void reload(true)} className="cc-press min-h-9 rounded-[8px] border border-line px-3 text-[13px] text-soft disabled:opacity-40">{busy ? 'Controllo…' : 'Ricontrolla'}</button>
      </div>
      {ORDER.map((s) => {
        const list = report.items.filter((i) => i.stato === s);
        if (!list.length) return null;
        const hidden = s === 'ok' && !showOk;
        return (
          <section key={s} aria-label={GROUP[s]} className="flex flex-col">
            <h3 className="m-0 mb-1 flex items-center justify-between gap-2 text-[12px] font-semibold tracking-wide text-muted uppercase">
              <span>{GROUP[s]} · {list.length}</span>
              {s === 'ok' && <button type="button" onClick={() => setShowOk((v) => !v)} className="text-[12px] font-normal tracking-normal normal-case text-soft hover:text-text">{showOk ? 'Nascondi' : 'Mostra'}</button>}
            </h3>
            {!hidden && list.map((i) => <ItemRow key={i.id} item={i} open={open === i.id} onToggle={() => setOpen((o) => (o === i.id ? null : i.id))} ctx={ctx} />)}
          </section>
        );
      })}
      <p className="m-0 text-[12px] text-muted">Controllato alle {new Date(report.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}. I passi da root si fanno sul server con <code className="font-mono">{rootStep('<passo>')}</code>.</p>
    </div>
  );
}

/** Pagina /configurazione: la stessa lista, a pagina intera. */
export function SetupPage({ setup, onBack, onGo }: { setup: SetupHook; onBack?: () => void; onGo: (section: string) => void }) {
  return (
    <div className="cc-safe-x min-h-dvh">
      <header className="cc-safe-top sticky top-0 z-20 border-b border-line/70 bg-ink/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[760px] items-center gap-3 px-4 py-3 sm:px-8">
          {onBack && <button type="button" onClick={onBack} aria-label="Torna indietro"
            className="cc-press flex h-9 flex-none items-center gap-1.5 rounded-[8px] border border-line px-2.5 text-[13px] text-soft hover:text-text">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
            <span className="hidden md:inline">Indietro</span>
          </button>}
          <PixelMark size={32} />
          <h1 className="pixel-16 m-0">Configurazione</h1>
        </div>
      </header>
      <main className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 pt-6 pb-32 sm:px-8 sm:pb-24">
        <p className="m-0 max-w-[65ch] text-[13px] leading-relaxed text-muted">Cosa serve a Ciccio sul tuo server, controllato adesso. Apri una voce per sistemarla passo per passo; quelle da root si fanno sul server con un comando da copiare. Resta in Impostazioni › Configurazione.</p>
        <div className="rounded-[14px] border border-line bg-panel px-5 py-5 sm:px-6">
          <SetupChecklist setup={setup} onGo={onGo} />
        </div>
      </main>
    </div>
  );
}
