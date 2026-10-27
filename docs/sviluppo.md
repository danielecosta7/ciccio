# Sviluppo

Cosa serve, per parte:

| Parte | Serve |
| - | - |
| Server e interfaccia (`server/`, `web/`, `shared/`) | Node 24 o più recente e pnpm con corepack (`corepack enable`; la versione di pnpm è in `package.json`). `better-sqlite3` scarica un binario già compilato; se per la tua piattaforma non c'è lo compila, e servono gli strumenti di compilazione (`build-essential` e `python3` su Ubuntu). Per far girare gli agenti su Linux: `bubblewrap` e `socat`. |
| Companion (`companion/`) | [Bun](https://bun.com) 1.3.x per compilare i binari (la CI usa la 1.3.14); per le prove basta Node. |
| App del companion per Mac (`companion/mac/`) | macOS con Xcode o i suoi strumenti a riga di comando (`xcode-select --install`), per Swift. |
| App desktop (`desktop/`) | Rust (rustup) e i [prerequisiti di Tauri 2](https://v2.tauri.app/start/prerequisites/) del tuo sistema; Node per la CLI di Tauri. |
| Voce (`voice/`) | Python 3.12 con `venv` (`python3-venv` su Ubuntu). |

```bash
corepack enable
pnpm install
pnpm dev:server   # API su 127.0.0.1:8787 (CICCIO_PROJECTS_DIR per scegliere i repo)
pnpm dev:web      # interfaccia su Vite (http://localhost:5173) con proxy verso il server
pnpm typecheck
pnpm build        # interfaccia in dist/web, server in dist/server
```

Le prove del companion che non hanno bisogno di finestre girano ovunque: `pnpm exec tsx companion/test/file.ts` (e `comandi.ts`, `migrazioni.ts`, `transfer.ts`). La CI le fa girare su Linux a ogni push e PR su `main`, insieme a `pnpm typecheck` e `pnpm build`.

Com'è fatto dentro (server, companion, app desktop, protocolli): [docs/tecnico.md](tecnico.md). Per contribuire: [CONTRIBUTING.md](../CONTRIBUTING.md).

Interfaccia e documentazione sono in italiano; l'inglese arriverà.

**Fork.** Se distribuisci un tuo companion o una tua app desktop, cambia gli identificativi `it.costa.ciccio` e `it.costa.ciccio-companion` (`desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/src/`, `companion/mac/`, `companion/src/service.ts`, `companion/src/windows-ui.ts`): con quelli il sistema riconosce l'app, le sue notifiche e i suoi dati, e due app con lo stesso identificativo si confondono.
