import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { Orb, PixelMark, PixelWordmark } from './ui';
import { rise } from './motion';
import { inDesktopApp } from './DesktopApp';

// originOk false: indirizzo che non è in CICCIO_ORIGINS (manca nei server di prima: vale come true).
// source: dove sta il codice sorgente di questo Ciccio (CICCIO_SOURCE_URL), per il link in fondo alla pagina.
interface AuthState { authenticated: boolean; hasPasskey: boolean; originOk?: boolean; source?: string }

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Errore ${res.status}`);
  return data as T;
}

const AuthCtx = createContext<{ logout: () => void } | null>(null);
export const useAuth = () => useContext(AuthCtx);

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Dispositivo';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
  return `${os}${browser ? ` · ${browser}` : ''}`;
}

/** Si entra solo con una passkey, da qualunque rete. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');

  const load = useCallback(async () => {
    try { setState(await (await fetch('/api/auth/state')).json() as AuthState); } catch { setError('Server non raggiungibile.'); }
  }, []);
  useEffect(() => {
    void load();
    // Una sessione scaduta mentre usi l'app riporta qui.
    const onExpired = () => void load();
    window.addEventListener('ciccio:auth', onExpired);
    return () => window.removeEventListener('ciccio:auth', onExpired);
  }, [load]);

  const login = async () => {
    setBusy(true); setError('');
    try {
      const { challengeId, options } = await post<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/api/auth/login/options');
      const response = await startAuthentication({ optionsJSON: options });
      await post('/api/auth/login/verify', { challengeId, response });
      await load();
    } catch (e) {
      setError(e instanceof Error && e.name !== 'NotAllowedError' ? e.message : 'Accesso annullato.');
    } finally { setBusy(false); }
  };

  const register = async () => {
    setBusy(true); setError('');
    try {
      const { challengeId, options } = await post<{ challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/api/auth/register/options', { code });
      const response = await startRegistration({ optionsJSON: options });
      await post('/api/auth/register/verify', { challengeId, response, name: deviceName() });
      await load();
    } catch (e) {
      setError(e instanceof Error && e.name !== 'NotAllowedError' ? e.message : 'Creazione annullata.');
    } finally { setBusy(false); }
  };

  const logout = useCallback(() => { void post('/api/auth/logout').then(load); }, [load]);

  // Nell'app desktop la passkey non c'è: la sessione la rifà l'app con il suo token (DESKTOP_LOGIN_PATH).
  // /desktop/relogin lo intercetta l'app; una volta sola al minuto, per non girare in tondo se non riesce.
  const needsRelogin = inDesktopApp && !!state && !state.authenticated;
  useEffect(() => {
    if (!needsRelogin) return;
    try {
      const last = Number(sessionStorage.getItem('ciccio.relogin') ?? 0);
      if (Date.now() - last < 60_000) return;
      sessionStorage.setItem('ciccio.relogin', String(Date.now()));
    } catch { /* memoria non disponibile: resta il pulsante */ }
    location.replace(`/desktop/relogin?next=${encodeURIComponent(location.pathname + location.search)}`);
  }, [needsRelogin]);

  if (state?.authenticated) return <AuthCtx.Provider value={{ logout }}>{children}</AuthCtx.Provider>;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-ink px-4 py-6">
      <AnimatePresence mode="wait">
        {!state ? (
          <motion.div key="wait" {...rise}><Orb state="connecting" size={32} label="Collegamento a Ciccio" /></motion.div>
        ) : state.originOk === false ? (
          <motion.div key="origin" {...rise} className="flex w-full max-w-[420px] flex-col items-center gap-4 rounded-[14px] border border-line bg-panel p-7 text-center">
            <PixelMark size={48} />
            <p className="m-0 text-[14px] leading-relaxed text-muted">
              Ciccio non accetta questo indirizzo, <span className="cc-selectable font-mono text-text">{location.origin}</span>: la passkey qui non funzionerebbe.
            </p>
            <div className="flex w-full flex-col gap-1.5 text-left text-[13px] leading-relaxed text-muted">
              <span>Sul server aggiungilo a <code className="font-mono text-soft">CICCIO_ORIGINS</code> in <code className="font-mono text-soft">~/.config/ciccio.env</code> (più indirizzi separati da virgola), poi riavvia:</span>
              <code className="cc-selectable cc-hscroll block overflow-x-auto whitespace-nowrap rounded-[8px] border border-line bg-ink px-2.5 py-1.5 font-mono text-[12px] text-soft">systemctl --user restart ciccio</code>
            </div>
          </motion.div>
        ) : needsRelogin ? (
          <motion.div key="app" {...rise} className="flex w-full max-w-[380px] flex-col items-center gap-5 rounded-[14px] border border-line bg-panel p-7 text-center">
            <PixelMark size={48} />
            <p className="m-0 text-[14px] leading-relaxed text-muted">La sessione dell'app è scaduta.</p>
            <a href={`/desktop/relogin?next=${encodeURIComponent(location.pathname + location.search)}`}
              className="cc-press flex min-h-12 w-full items-center justify-center rounded-full bg-acid text-[15px] font-semibold text-ink">Entra di nuovo</a>
          </motion.div>
        ) : (
          <motion.form key="form" {...rise} onSubmit={(e) => { e.preventDefault(); void (state.hasPasskey && !code ? login() : register()); }}
            className="flex w-full max-w-[380px] flex-col items-center gap-5 rounded-[14px] border border-line bg-panel p-7 text-center">
            <PixelMark size={48} />
            <h1 className="m-0 flex h-6 items-center"><PixelWordmark scale={3} /></h1>
            {state.hasPasskey ? (
              <>
                <p className="m-0 text-[14px] leading-relaxed text-muted">Entra con la passkey di questo dispositivo (Face ID, Touch ID o impronta).</p>
                <button type="button" onClick={() => void login()} disabled={busy}
                  className="cc-press min-h-12 w-full rounded-full bg-acid text-[15px] font-semibold text-ink disabled:opacity-60">{busy ? 'Verifico…' : 'Entra'}</button>
                <details className="w-full text-left text-[13px] text-muted">
                  <summary className="cursor-pointer text-center">Nuovo dispositivo? Usa un codice</summary>
                  <div className="mt-3 flex flex-col gap-2">
                    <span className="text-[12.5px] leading-relaxed">Il codice lo crei da un dispositivo già dentro, con «Aggiungi dispositivo».</span>
                    <CodeField code={code} setCode={setCode} />
                    <button type="button" onClick={() => void register()} disabled={busy || code.length < 11}
                      className="cc-press min-h-11 rounded-full border border-line-hi text-[14px] font-medium text-text disabled:opacity-50">Crea la passkey qui</button>
                  </div>
                </details>
              </>
            ) : (
              <>
                <p className="m-0 text-[14px] leading-relaxed text-muted">Prima volta da questo indirizzo: inserisci il codice di attivazione e crea la passkey.</p>
                <div className="flex w-full flex-col gap-1.5 text-left text-[12.5px] leading-relaxed text-muted">
                  Il codice è nel registro del servizio. Sul server:
                  <code className="cc-selectable cc-hscroll block overflow-x-auto whitespace-nowrap rounded-[8px] border border-line bg-ink px-2.5 py-1.5 font-mono text-[12px] text-soft">journalctl --user -u ciccio | grep attivazione | tail -1</code>
                </div>
                <CodeField code={code} setCode={setCode} />
                <button type="submit" disabled={busy || code.length < 11}
                  className="cc-press min-h-12 w-full rounded-full bg-acid text-[15px] font-semibold text-ink disabled:opacity-50">{busy ? 'Un attimo…' : 'Crea la passkey'}</button>
              </>
            )}
            {error && <div className="text-[13px] text-block">{error}</div>}
          </motion.form>
        )}
      </AnimatePresence>
      {state?.source && <SourceLink href={state.source} />}
    </div>
  );
}

/** Link al codice sorgente (AGPL-3.0, sezione 13): piccolo, in fondo alla pagina di accesso. */
function SourceLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-[12px] text-muted underline-offset-2 hover:text-soft hover:underline">
      Codice sorgente · AGPL-3.0
    </a>
  );
}

/** Solo lettere e cifre del codice, in maiuscolo; il trattino lo mette da solo dopo i primi 5 caratteri. */
function formatCode(v: string): string {
  const raw = v.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 10);
  return raw.length > 5 ? `${raw.slice(0, 5)}-${raw.slice(5)}` : raw;
}

function CodeField({ code, setCode }: { code: string; setCode: (v: string) => void }) {
  return (
    <label className="w-full">
      <span className="sr-only">Codice di attivazione</span>
      <input value={code} onChange={(e) => setCode(formatCode(e.target.value))}
        placeholder="ABCDE-12345" autoComplete="one-time-code" inputMode="text" spellCheck={false}
        autoCapitalize="characters" autoCorrect="off" enterKeyHint="go"
        className="min-h-12 w-full rounded-[10px] border border-line-hi bg-ink px-4 text-center font-mono text-[18px] tracking-[0.12em] text-text outline-none focus:border-acid placeholder:text-muted/60" />
    </label>
  );
}

/** Pulsanti nella dashboard: codice per un nuovo dispositivo, ed esci. */
export function AuthControls() {
  const auth = useAuth();
  const [code, setCode] = useState<string | null>(null);
  const make = async () => {
    try { setCode((await post<{ code: string }>('/api/auth/device-code')).code); } catch { setCode(null); }
  };
  return (
    <span className="relative inline-flex items-center gap-2">
      <button type="button" onClick={() => void make()} title="Genera un codice per creare una passkey su un altro dispositivo (vale 30 minuti)"
        aria-label="Aggiungi dispositivo" className="cc-press inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[13px] text-muted hover:text-text">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3" /></svg>
        <span className="hidden sm:inline">Aggiungi dispositivo</span>
      </button>
      {auth && (
        <button type="button" onClick={auth.logout} className="cc-press inline-flex items-center rounded-full border border-line px-3 py-1.5 text-[13px] text-muted hover:text-text">Esci</button>
      )}
      <AnimatePresence>
        {code && (
          <motion.span key="code" {...rise} className="absolute top-full right-0 z-30 mt-2 flex w-[280px] flex-col gap-2 rounded-[12px] border border-line-hi bg-panel p-4 text-left shadow-[0_6px_8px_rgb(0_0_0/.45)]">
            <span className="text-[13px] text-muted">Apri {location.host} sul nuovo dispositivo e inserisci:</span>
            <span className="cc-selectable font-mono text-[22px] tracking-[0.12em] text-acid">{code}</span>
            <span className="text-[12px] text-muted">Vale 30 minuti, una volta sola.</span>
            <button type="button" onClick={() => setCode(null)} className="self-end text-[13px] text-soft hover:text-text">Chiudi</button>
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
