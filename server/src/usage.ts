import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv, config } from './config.js';
import { store } from './db.js';
import { bus } from './bus.js';
import type { AuthMode, Usage, UsageState, UsageWindow } from '../../shared/types.js';

// Come si collegano le sessioni a Claude e quanto consumano.
// Ciccio usa solo il login di claude.ai (abbonamento) dell'utente del server: le chat agentiche lunghe con
// connettori, skill e contesto dell'account sono provate così. Le credenziali a consumo (ANTHROPIC_API_KEY, gateway,
// Bedrock, Vertex, Foundry) non passano alle sessioni (config.ts). L'uso arriva dagli eventi rate_limit_event di
// ogni sessione: finestra di 5 ore e settimanale.

const STALE_MS = 15 * 60_000;
let probing: Promise<void> | null = null;
let probedAt = 0;

// ── Accesso ─────────────────────────────────────────────────────────────

const credentialsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), '.credentials.json');

/** Prima di vedere una sessione: dai file di Claude Code sul server (o dal token di claude setup-token). */
function guessAuth(): AuthMode {
  return claudeEnv.CLAUDE_CODE_OAUTH_TOKEN || fs.existsSync(credentialsFile()) ? 'subscription' : 'none';
}

/** Ultima sessione vista da quando il server è partito: vale più della stima dai file. */
let seen: { source: string; at: number } | null = null;

export function authMode(): AuthMode {
  // apiKeySource del messaggio init: 'none' vuol dire nessuna chiave, cioè il login di claude.ai.
  return seen ? (seen.source === 'none' ? 'subscription' : 'none') : guessAuth();
}

/** Le sessioni girano con il login di claude.ai: limiti di 5 ore e settimana, connettori e skill dell'account. */
export const onSubscription = () => authMode() === 'subscription';

export function authInfo(): { mode: AuthMode; seenAt: number | null } {
  return { mode: authMode(), seenAt: seen?.at ?? null };
}

/** All'avvio, nel registro: con che cosa partiranno le sessioni. */
export function logAuth() {
  if (guessAuth() === 'subscription') console.log(`Claude: login di claude.ai di questo utente (${credentialsFile()}).`);
  else console.warn(`Nessun login di claude.ai per questo utente: le sessioni non partiranno. Accedi con: ${claudeBin()} auth login --claudeai`);
}

/** Il programma di Claude Code che arriva con l'SDK (pacchetto per piattaforma), per il comando di accesso. */
export function claudeBin(): string {
  try {
    const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    return path.join(path.dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude');
  } catch {
    return 'claude';
  }
}

// ── Uso ─────────────────────────────────────────────────────────

function win(w: unknown): UsageWindow | null {
  if (!w || typeof w !== 'object') return null;
  const o = w as { utilization?: number; resetsAt?: number };
  if (typeof o.utilization !== 'number' || typeof o.resetsAt !== 'number') return null;
  return { utilization: o.utilization, resetsAt: o.resetsAt * 1000 };
}

/** Uso dell'abbonamento; null senza login. */
export function currentUsage(): Usage | null {
  return onSubscription() ? store.getKv<Usage>('usage') ?? null : null;
}

export function usageState(): UsageState {
  return { auth: authMode(), usage: currentUsage() };
}

const emit = () => bus.emit({ type: 'usage', state: usageState() });

/** Da chiamare con ogni messaggio dell'SDK: accesso usato e uso dell'abbonamento. */
export function recordUsage(msg: SDKMessage) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    const before = authMode();
    seen = { source: msg.apiKeySource, at: Date.now() };
    if (authMode() !== before) emit();
    return;
  }
  if (msg.type !== 'rate_limit_event') return;
  const info = msg.rate_limit_info as { unifiedWindows?: { five_hour?: unknown; seven_day?: unknown } };
  const prev = store.getKv<Usage>('usage');
  const usage: Usage = {
    fiveHour: win(info.unifiedWindows?.five_hour) ?? prev?.fiveHour ?? null,
    sevenDay: win(info.unifiedWindows?.seven_day) ?? prev?.sevenDay ?? null,
    updatedAt: Date.now(),
  };
  store.setKv('usage', usage);
  emit();
}

/**
 * Se il dato è vecchio, una sessione minima su Haiku (nessuno strumento) per aggiornarlo.
 * Solo con il login: senza, la sessione non partirebbe.
 */
export function refreshUsageIfStale(): Promise<void> {
  if (!onSubscription()) return Promise.resolve();
  const u = currentUsage();
  if (u && Date.now() - u.updatedAt < STALE_MS) return Promise.resolve();
  if (probing) return probing;
  // Anche se la prova non porta il dato (errore, nessun evento), non si riprova a ogni pagina aperta.
  if (Date.now() - probedAt < STALE_MS) return Promise.resolve();
  probedAt = Date.now();
  probing = (async () => {
    try {
      const q = query({
        prompt: 'Rispondi solo: ok',
        options: {
          cwd: config.dataDir, model: 'claude-haiku-5-5', maxTurns: 1, settingSources: [],
          tools: [], permissionMode: 'dontAsk', env: { ...claudeEnv, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
        },
      });
      for await (const msg of q) recordUsage(msg);
    } catch (err) {
      console.error('Lettura uso Claude non riuscita:', err);
    } finally {
      probing = null;
    }
  })();
  return probing;
}
