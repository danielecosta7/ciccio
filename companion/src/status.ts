import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config.js';

// Stato del companion in un file (~/.ciccio-companion/status.json) che l'app della barra dei menu
// legge ogni due secondi: collegato o no, a chi, con quali server MCP, ultimo problema.

export interface CompanionStatus {
  connected: boolean;
  device: string | null;
  server: string;
  problem: string;
  rejected: boolean;
  servers: { name: string; status: string; tools: number; error?: string }[];
  lastCall: { server: string; name: string; ok: boolean; at: number } | null;
  /** Versione nuova scaricata e controllata, pronta da installare (la installa l'app del Mac). */
  update?: { version: string; path: string } | null;
  pid: number;
  updatedAt: number;
}

const state: CompanionStatus = {
  connected: false, device: null, server: '', problem: '', rejected: false, servers: [], lastCall: null, pid: process.pid, updatedAt: 0,
};

const file = () => path.join(configDir(), 'status.json');
let pending: ReturnType<typeof setTimeout> | undefined;
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Aggiorna lo stato e lo scrive (al massimo ogni 200 ms, con rinomina atomica). */
export function setStatus(patch: Partial<CompanionStatus>) {
  Object.assign(state, patch);
  if (patch.problem != null) state.problem = plain(patch.problem);
  if (pending) return;
  pending = setTimeout(() => {
    pending = undefined;
    state.updatedAt = Date.now();
    try {
      fs.mkdirSync(configDir(), { recursive: true });
      const tmp = `${file()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file());
    } catch { /* lo stato è solo per l'app della barra dei menu */ }
  }, 200);
}

export function clearStatus() {
  try { fs.rmSync(file(), { force: true }); } catch { /* niente da togliere */ }
}
