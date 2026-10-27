# Contribuire

Grazie dell'interesse. Ciccio è nato come strumento personale ed è diventato open source da poco: le regole sono poche e possono cambiare.

## Prima di scrivere codice

- **Bug**: apri una issue con i passi per riprodurlo, cosa ti aspettavi e cosa è successo (versione di Ciccio, sistema del server, browser o PC).
- **Idee e funzioni nuove**: apri prima una issue per parlarne. Ciccio ha principi precisi (chi ti aspetta prima di tutto, calmo per ore, i dati restano tuoi): una proposta discussa prima evita lavoro buttato.
- **Falle di sicurezza**: non in una issue pubblica, vedi [SECURITY.md](SECURITY.md).

## Pull request

1. Un fork, un branch per modifica, una PR piccola e su un solo argomento.
2. `pnpm install`, poi `pnpm typecheck` e `pnpm build` devono passare (la CI li rifà a ogni PR, con le prove del companion che girano su Linux). Se tocchi il companion o l'app desktop, fai girare i loro test (`companion/test`, `desktop/test`) dove puoi. Cosa serve per compilare ogni parte: [README](README.md#sviluppo).
3. Scrivi come il codice intorno: stessi nomi, stessa densità di commenti. Commenti, messaggi e testi dell'interfaccia sono in italiano, con frasi brevi e dirette.
4. Niente dati personali nel codice: il nome dell'utente arriva da `CICCIO_OWNER_NAME` (`OWNER` nel server), gli indirizzi da `CICCIO_ORIGINS`.
5. Nella PR spiega cosa cambia e perché, e come l'hai provato.

Mandando una PR accetti che il tuo contributo sia distribuito con la licenza del progetto, [AGPL-3.0-only](LICENSE). Codice preso da altri progetti va bene solo con una licenza compatibile: dillo nella PR e aggiungilo a [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
