import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { config, OWNER } from './config.js';
import { authStore } from './db.js';
import { COMPANION_DOWNLOAD_PATH, COMPANION_PATH, COMPANION_TRANSFER_PATH } from '../../shared/companion.js';
import { DESKTOP_PATH } from '../../shared/desktop.js';

// Ogni richiesta, da qualunque rete arrivi, entra con una sessione (passkey) o con il token del suo dispositivo.
// Nessun indirizzo è fidato di per sé: né Tailscale, né la rete locale, né 127.0.0.1.

const COOKIE = 'ciccio_s';
const SESSION_DAYS = 30;
const CODE_MINUTES = 30;

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Token per gli script del server (install.sh chiede a Ciccio chi sta lavorando prima di riavviarlo): sta in
 * CICCIO_DATA_DIR, che gli agenti non vedono, e cambia a ogni avvio. Vale solo per le rotte di LOCAL_ROUTES.
 */
const LOCAL_TOKEN_FILE = 'local-token';
let localToken = '';

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(sha(a), 'hex');
  const y = Buffer.from(sha(b), 'hex');
  return timingSafeEqual(x, y);
}

/**
 * Rotte aperte al token locale: solo le letture che servono a install.sh (chi sta lavorando prima di un riavvio) e
 * il codice per aggiungere un dispositivo, da stampare dalla shell del server. Tutto il resto vuole la passkey: chi
 * legge il file del token non comanda Ciccio (permessi, chat, impostazioni, companion).
 */
const LOCAL_ROUTES = new Set(['GET /api/activity', 'GET /api/agents', 'GET /api/ciccio/state', 'POST /api/auth/device-code']);

function viaLocalToken(req: FastifyRequest): boolean {
  const t = req.headers['x-ciccio-local'];
  if (typeof t !== 'string' || localToken === '' || !sameSecret(t, localToken)) return false;
  // La rotta scelta dal router (con i %xx già decodificati), non il testo dell'indirizzo.
  const url = req.routeOptions.url ?? null;
  return url != null && LOCAL_ROUTES.has(`${req.method} ${url}`);
}

function cookies(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionOf(req: FastifyRequest) {
  const token = cookies(req)[COOKIE];
  if (!token) return null;
  const s = authStore.session(sha(token));
  return s && s.expires_at > Date.now() ? s : null;
}

/** Autorizzato: ha una sessione valida (o il token locale degli script del server, sulle sue rotte). */
export function isAuthed(req: FastifyRequest): boolean {
  return sessionOf(req) != null || viaLocalToken(req);
}

/**
 * Sessione nuova con il suo cookie. `persistent` false (app desktop): cookie senza Max-Age, che il sistema tiene
 * solo in memoria; a ogni avvio l'app ne chiede una nuova con il suo token, che sta nel Portachiavi.
 */
export function startSession(reply: FastifyReply, label: string, persistent = true) {
  const token = randomBytes(32).toString('base64url');
  authStore.addSession(sha(token), Date.now() + SESSION_DAYS * 86_400_000, label);
  reply.header('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict${persistent ? `; Max-Age=${SESSION_DAYS * 86_400}` : ''}`);
}

/**
 * Codice monouso per registrare una passkey (prima volta o nuovo dispositivo). Vale CODE_MINUTES, ma finché non c'è
 * nessuna passkey quello della prima volta non scade. Uno nuovo prende il posto del precedente.
 */
export function newSetupCode(): string {
  const raw = randomBytes(5).toString('hex').toUpperCase();
  const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  authStore.setCode(sha(code), Date.now() + CODE_MINUTES * 60_000);
  codeFails = [];
  return code;
}

/** L'impronta del codice di attivazione se `code` è quello giusto e vale ancora, altrimenti null. Non lo consuma. */
function setupCodeHash(code: string): string | null {
  const saved = authStore.code();
  if (!saved || (saved.expires_at < Date.now() && authStore.credentials().length > 0)) return null;
  const a = Buffer.from(saved.hash, 'hex');
  const b = Buffer.from(sha(code.trim().toUpperCase()), 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? saved.hash : null;
}

// Tentativi falliti per indirizzo: oltre 10 in 10 minuti si aspetta. L'indirizzo è req.ip: quello della connessione,
// o quello in X-Forwarded-For solo se arriva da un proxy fidato (CICCIO_TRUST_PROXY, di base solo 127.0.0.1).
const attempts = new Map<string, number[]>();
export function limited(req: FastifyRequest): boolean {
  const now = Date.now();
  const list = (attempts.get(req.ip) ?? []).filter((t) => now - t < 10 * 60_000);
  if (list.length) attempts.set(req.ip, list); else attempts.delete(req.ip);
  return list.length >= 10;
}
export function failed(req: FastifyRequest) {
  attempts.set(req.ip, [...(attempts.get(req.ip) ?? []), Date.now()]);
}

// Codici di attivazione sbagliati da tutti gli indirizzi insieme: oltre CODE_FAILS_MAX in un'ora il codice non si
// accetta più (nemmeno quello giusto) finché non se ne crea uno nuovo. Così non si indovina cambiando indirizzo.
const CODE_FAILS_MAX = 50;
let codeFails: number[] = [];
function codeLocked(): boolean {
  const now = Date.now();
  codeFails = codeFails.filter((t) => now - t < 60 * 60_000);
  return codeFails.length >= CODE_FAILS_MAX;
}

// Sfide in attesa (scadono dopo 5 minuti). Quella di una passkey nuova entrata con il codice se ne ricorda l'impronta:
// il codice si consuma solo quando la passkey è creata davvero (Face ID annullato = codice ancora buono).
const challenges = new Map<string, { challenge: string; exp: number; code?: string }>();
function keepChallenge(challenge: string, code?: string): string {
  const id = randomBytes(16).toString('base64url');
  challenges.set(id, { challenge, exp: Date.now() + 5 * 60_000, code });
  for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k);
  return id;
}
function takeChallenge(id: string): { challenge: string; code?: string } | null {
  const c = challenges.get(id);
  challenges.delete(id);
  return c && c.exp > Date.now() ? c : null;
}

const PUBLIC_PATHS = ['/api/auth/'];
// Il companion dei PC non ha una sessione: entra con il token del dispositivo, controllato dalla sua rotta.
const isCompanion = (url: string) => url === COMPANION_PATH || url.startsWith(`${COMPANION_PATH}?`) || url.startsWith(`${COMPANION_DOWNLOAD_PATH}/`) || isTransfer(url);
/** File tra il PC e il repo (carica_su_ciccio è un PUT): entra con il token del dispositivo e un token monouso, mai con i cookie. */
const isTransfer = (url: string) => url.startsWith(`${COMPANION_TRANSFER_PATH}/`);
/** L'app desktop (desktop.ts): entra con il suo token, o con un codice monouso per la finestra; mai con i cookie. */
const isDesktop = (url: string) => url === DESKTOP_PATH || url.startsWith(`${DESKTOP_PATH}?`) || url.startsWith(`${DESKTOP_PATH}/`);
const isAsset = (url: string) => !url.startsWith('/api/') && !url.startsWith('/download/') && url !== '/ws' && !url.startsWith('/ws?') && !isCompanion(url) && !isDesktop(url);

export function registerAuth(app: FastifyInstance) {
  const origins = config.origins;
  const rpIDs = origins.map((o) => new URL(o).hostname);
  /** La passkey vale per il nome dell'indirizzo da cui la si usa: ogni indirizzo ha le sue. */
  const rpIDOf = (req: FastifyRequest) => {
    const i = origins.indexOf(String(req.headers.origin ?? ''));
    return i >= 0 ? rpIDs[i] : null;
  };
  /** L'indirizzo da cui si è aperto Ciccio è tra quelli di CICCIO_ORIGINS? Senza Origin (GET dalla stessa pagina) conta l'host. */
  const hosts = origins.map((o) => new URL(o).host);
  const originOk = (req: FastifyRequest) => (req.headers.origin ? origins.includes(String(req.headers.origin)) : hosts.includes(req.host));
  /** Il 403 dice quale indirizzo è stato usato e dove aggiungerlo, invece di un «origine non valida» e basta. */
  const badOrigin = (req: FastifyRequest) => ({
    error: `Ciccio non accetta l'indirizzo ${String(req.headers.origin || req.host || '(sconosciuto)').slice(0, 200)}: aggiungilo a CICCIO_ORIGINS in ~/.config/ciccio.env sul server e riavvia Ciccio.`,
  });
  /** Senza passkey il codice della prima volta finisce nel registro del servizio: l'ultima riga con «attivazione» è quello buono. */
  const announceCode = (code: string) => app.log.warn(`Nessuna passkey registrata. Codice di attivazione: ${code} (vale finché non crei la prima passkey; uno nuovo, o un riavvio, lo sostituisce)`);

  localToken = randomBytes(32).toString('base64url');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, LOCAL_TOKEN_FILE), localToken, { mode: 0o600 });

  // Ogni richiesta passa da qui: pagina e risorse statiche sì, API e WebSocket solo con sessione.
  // Si decide sulla rotta che il router ha scelto, non sul testo dell'indirizzo: il router decodifica i %xx, quindi
  // /%61pi/agents arriva a /api/agents e un controllo sul testo grezzo lo scambierebbe per un file statico.
  // Senza rotta (pagina non trovata) risponde solo il notFound: index.html, o 404 per le API.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.routeOptions.url ?? null;
    if (viaLocalToken(req)) return;
    if (url == null) return;
    const origin = String(req.headers.origin ?? '');
    // Il controllo dell'origine protegge le sessioni del browser; i trasferimenti del companion non usano cookie.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !origins.includes(origin) && !isTransfer(url) && !isDesktop(url)) {
      return reply.code(403).send(badOrigin(req));
    }
    // La WebSocket degli eventi usa il cookie: solo dalle pagine di Ciccio (un sottodominio dello stesso sito no).
    if (url === '/ws' && !origins.includes(origin)) return reply.code(403).send(badOrigin(req));
    if (isAsset(url) || isCompanion(url) || isDesktop(url) || PUBLIC_PATHS.some((p) => url.startsWith(p))) return;
    if (!sessionOf(req)) return reply.code(401).send({ error: 'accesso richiesto' });
  });

  app.get('/api/auth/state', async (req) => ({
    // Sempre true: le app desktop fino alla 0.x si creavano il token da sole quando era false (accesso da Tailscale).
    public: true,
    authenticated: isAuthed(req),
    hasPasskey: authStore.credentials().length > 0,
    // false: la pagina è aperta da un indirizzo che non è in CICCIO_ORIGINS, e la passkey non andrebbe. Lo dice subito.
    originOk: originOk(req),
    // Link «Codice sorgente» della pagina di accesso (AGPL-3.0, sezione 13): solo l'indirizzo, senza il commit.
    source: config.sourceUrl,
  }));

  app.post<{ Body: { code?: string } }>('/api/auth/register/options', async (req, reply) => {
    if (limited(req)) return reply.code(429).send({ error: 'Troppi tentativi, riprova tra qualche minuto.' });
    // Nuova passkey: con una sessione valida, oppure con il codice di attivazione (che qui si controlla e basta).
    const rpID = rpIDOf(req);
    if (!rpID) return reply.code(403).send(badOrigin(req));
    let code: string | undefined;
    if (!sessionOf(req)) {
      if (codeLocked()) return reply.code(429).send({ error: 'Troppi codici sbagliati: per sicurezza il codice è bloccato. Creane uno nuovo sul server (riavvia Ciccio) o da un dispositivo già dentro.' });
      code = setupCodeHash(req.body?.code ?? '') ?? undefined;
      if (!code) {
        failed(req);
        codeFails.push(Date.now());
        return reply.code(403).send({ error: 'Codice non valido o scaduto.' });
      }
    }
    const options = await generateRegistrationOptions({
      rpName: 'Ciccio', rpID, userName: OWNER.toLowerCase(), userDisplayName: OWNER,
      userID: new TextEncoder().encode(OWNER.toLowerCase()),
      attestationType: 'none',
      excludeCredentials: authStore.credentials().map((c) => ({ id: c.id, transports: JSON.parse(c.transports) as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    return { challengeId: keepChallenge(options.challenge, code), options };
  });

  app.post<{ Body: { challengeId?: string; response?: RegistrationResponseJSON; name?: string } }>('/api/auth/register/verify', async (req, reply) => {
    const taken = takeChallenge(req.body?.challengeId ?? '');
    if (!taken || !req.body?.response) return reply.code(400).send({ error: 'Richiesta scaduta, riprova.' });
    try {
      const v = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge: taken.challenge, expectedOrigin: origins, expectedRPID: rpIDs, requireUserVerification: true });
      if (!v.verified || !v.registrationInfo) throw new Error('non verificata');
      // Entrata con il codice: si consuma adesso, se nel frattempo non l'ha usato un'altra richiesta o non ne è arrivato uno nuovo.
      if (taken.code) {
        if (authStore.code()?.hash !== taken.code) return reply.code(400).send({ error: 'Codice già usato o sostituito da uno nuovo: inserisci quello nuovo.' });
        authStore.clearCode();
      }
      const c = v.registrationInfo.credential;
      const name = (req.body.name ?? 'Dispositivo').slice(0, 60);
      authStore.addCredential(c.id, Buffer.from(c.publicKey), c.counter, JSON.stringify(c.transports ?? []), name);
      startSession(reply, name);
      return { ok: true };
    } catch {
      failed(req);
      return reply.code(400).send({ error: 'Passkey non verificata.' });
    }
  });

  app.post('/api/auth/login/options', async (req, reply) => {
    if (limited(req)) return reply.code(429).send({ error: 'Troppi tentativi, riprova tra qualche minuto.' });
    const rpID = rpIDOf(req);
    if (!rpID) return reply.code(403).send(badOrigin(req));
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    return { challengeId: keepChallenge(options.challenge), options };
  });

  app.post<{ Body: { challengeId?: string; response?: AuthenticationResponseJSON } }>('/api/auth/login/verify', async (req, reply) => {
    const challenge = takeChallenge(req.body?.challengeId ?? '')?.challenge;
    const response = req.body?.response;
    if (!challenge || !response) return reply.code(400).send({ error: 'Richiesta scaduta, riprova.' });
    const cred = authStore.credential(response.id);
    if (!cred) { failed(req); return reply.code(400).send({ error: 'Passkey sconosciuta.' }); }
    try {
      const v = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge, expectedOrigin: origins, expectedRPID: rpIDs, requireUserVerification: true,
        credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: cred.counter, transports: JSON.parse(cred.transports) as AuthenticatorTransportFuture[] },
      });
      if (!v.verified) throw new Error('non verificata');
      authStore.updateCounter(cred.id, v.authenticationInfo.newCounter);
      startSession(reply, cred.name);
      return { ok: true };
    } catch {
      failed(req);
      return reply.code(400).send({ error: 'Passkey non verificata.' });
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = cookies(req)[COOKIE];
    if (token) authStore.dropSession(sha(token));
    reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  // Passkey registrate: elenco e rimozione (solo da chi è già dentro).
  app.get('/api/auth/passkeys', async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: 'accesso richiesto' });
    return authStore.credentials().map((c) => ({ id: c.id, name: c.name, createdAt: c.created_at }));
  });
  app.post<{ Body: { id?: string } }>('/api/auth/passkeys/remove', async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: 'accesso richiesto' });
    if (req.body?.id) authStore.removeCredential(req.body.id);
    // Tolta l'ultima: senza un codice nuovo, alla prossima sessione scaduta non entrerebbe più nessuno.
    if (authStore.credentials().length === 0) announceCode(newSetupCode());
    return { ok: true };
  });
  // Esce da tutti i dispositivi: servirà di nuovo la passkey ovunque.
  app.post('/api/auth/logout-all', async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: 'accesso richiesto' });
    authStore.dropAllSessions();
    reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  // Codice per aggiungere un dispositivo: solo da chi è già dentro (o dagli script del server, con il token locale).
  // Senza passkey è il codice della prima volta: non scade, e va anche nel registro al posto del precedente.
  app.post('/api/auth/device-code', async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: 'accesso richiesto' });
    const code = newSetupCode();
    const first = authStore.credentials().length === 0;
    if (first) announceCode(code);
    return { code, minutes: CODE_MINUTES, expires: !first };
  });

  // Prima volta: senza passkey registrate, il codice di attivazione finisce nel registro del servizio.
  if (authStore.credentials().length === 0) announceCode(newSetupCode());
}
