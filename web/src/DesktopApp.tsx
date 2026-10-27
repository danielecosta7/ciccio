import { useEffect, useState } from 'react';
import { NO_PACKAGE, api, timeAgo, useDownloads } from './api';
import { CopyLine } from './Setup';
import type { DesktopAppView } from '../../shared/types';

// App desktop «Ciccio» (desktop/): finestra con Ciccio e notifiche native con Consenti e Rifiuta.
// Qui: scaricarla, confermare il codice con cui si collega da internet, vedere e scollegare le app.

/** Dentro la finestra dell'app: lo dice lo script che l'app aggiunge alle pagine di Ciccio. */
export const inDesktopApp = typeof window !== 'undefined' && !!(window as { __CICCIO_APP__?: unknown }).__CICCIO_APP__;

const pcOs: 'mac' | 'windows' | null = typeof navigator === 'undefined' || /iPhone|iPad|Android/.test(navigator.userAgent) ? null
  : /Mac/.test(navigator.platform || navigator.userAgent) ? 'mac'
  : /Win/.test(navigator.platform || navigator.userAgent) ? 'windows' : null;

const DOWNLOADS = [
  { os: 'mac', label: 'Scarica per Mac', file: '/download/Ciccio-mac.dmg', note: "Mac con Apple Silicon. Apri il file e trascina Ciccio in Applicazioni. La prima volta macOS la blocca perché non è firmata da Apple: Impostazioni di Sistema › Privacy e sicurezza › «Apri comunque»." },
  { os: 'windows', label: 'Scarica per Windows', file: '/download/Ciccio-windows-setup.exe', note: "Windows 10 o 11, 64 bit. Si installa nella tua cartella utente, senza amministratore. SmartScreen la blocca perché non è firmata: «Ulteriori informazioni» › «Esegui comunque»." },
] as const;

const formatCode = (v: string) => { const raw = v.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8); return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw; };

export function DesktopAppSection({ apps }: { apps: DesktopAppView[] }) {
  // Il codice si scrive a mano guardando l'app: mai preso dall'indirizzo, se no un link di phishing
  // con il codice di un'altra app la farebbe collegare con un clic.
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [list, setList] = useState(apps);
  useEffect(() => setList(apps), [apps]);
  const downloads = useDownloads();

  const pair = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api.approveDesktopApp(code);
      setNote({ ok: true, text: `Collegata «${r.app?.name ?? 'app'}»: torna all'app, si apre da sola.` });
      setCode('');
    } catch (e) { setNote({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-5">
      {inDesktopApp && <p className="m-0 text-[13px] text-done">Stai usando l'app adesso.</p>}

      <div className="flex flex-col gap-3">
        {DOWNLOADS.map((d) => (
          <div key={d.os} className={`flex flex-col gap-1.5 ${pcOs && pcOs !== d.os ? 'opacity-70' : ''}`}>
            {!downloads || downloads.has(d.file.replace(/^.*\//, ''))
              ? <a href={d.file} className={`cc-press self-start rounded-[10px] px-4 py-2 text-[13.5px] font-semibold ${pcOs === d.os ? 'bg-acid text-ink' : 'border border-line-hi text-text'}`}>{d.label}</a>
              : <span className="text-[13px] font-medium text-wait">{d.label.replace('Scarica', 'App')}: {NO_PACKAGE}</span>}
            <span className="text-[12.5px] leading-snug text-muted">{d.note}</span>
          </div>
        ))}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Indirizzo del server</span>
          <CopyLine text={location.origin} label="Copia l'indirizzo del server" />
          <span className="text-[12.5px] leading-snug text-muted">L'app lo chiede appena la apri: incollalo lì.</span>
        </div>
        <p className="m-0 text-[12.5px] leading-snug text-muted">
          Poi l'app ti mostra un codice e apre questa pagina nel browser: conferma qui sotto.
          Con l'app accesa, le notifiche di Ciccio le mostra lei; il Companion dello stesso PC resta per gli strumenti e smette di mandarle doppie.
        </p>
      </div>

      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void pair(); }}>
        <label className="flex min-w-[200px] flex-1 flex-col gap-1">
          <span className="text-[13px] font-medium">Codice mostrato dall'app</span>
          <input value={code} onChange={(e) => setCode(formatCode(e.target.value))} placeholder="XXXX-XXXX" autoCapitalize="characters" autoCorrect="off" spellCheck={false} aria-label="Codice dell'app"
            className="rounded-[8px] border border-line bg-ink px-3 py-2 font-mono text-[15px] tracking-[0.12em] outline-none focus:border-acid" />
        </label>
        <button type="submit" disabled={busy || code.length < 9}
          className="cc-press mt-5 rounded-[10px] bg-acid px-4 py-2 text-[13.5px] font-semibold text-ink disabled:opacity-40">{busy ? 'Collego…' : 'Collega'}</button>
      </form>
      {note && <div className={`text-[12.5px] ${note.ok ? 'text-done' : 'text-block'}`}>{note.text}</div>}

      {list.length > 0 && (
        <div className="flex flex-col">
          {list.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3 border-t border-line/60 py-2.5 first:border-t-0">
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[14px] font-medium">{a.name}</span>
                <span className="text-[12px] text-muted">
                  {a.online ? 'accesa' : a.lastSeen ? `vista ${timeAgo(a.lastSeen)} fa` : 'mai collegata'}
                  {a.platform ? ` · ${a.platform.startsWith('darwin') ? 'Mac' : 'Windows'}` : ''}{a.version ? ` · ${a.version}` : ''}
                  {a.online && a.companion ? ` · notifiche al posto del Companion «${a.companion}»` : ''}
                </span>
              </span>
              <button type="button" onClick={() => { if (confirm(`Scollegare l'app «${a.name}»? Per riusarla andrà collegata di nuovo.`)) void api.removeDesktopApp(a.id).then(() => setList((l) => l.filter((x) => x.id !== a.id))); }}
                className="cc-press min-h-9 rounded-[8px] border border-line px-3 text-[13px] text-muted hover:border-block/50 hover:text-block">Scollega</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
