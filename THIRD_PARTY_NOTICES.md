# Avvisi di terze parti

Ciccio è © 2026 Daniele Costa, con licenza [AGPL-3.0-only](LICENSE). Usa, e in parte incorpora, lavoro di altri. Qui trovi:

- quello che serve a Ciccio ma **non** è coperto dalla sua licenza;
- il codice di altri adattato dentro questo repo, con le sue licenze;
- i caratteri e le dipendenze con licenze diverse da quelle permissive (MIT, ISC, BSD, Apache-2.0 e simili).

Tutte le altre dipendenze hanno licenze permissive. L'elenco completo, con le versioni, è nei lockfile: `pnpm-lock.yaml` (server, interfaccia, companion), `desktop/src-tauri/Cargo.lock` (app desktop) e `voice/requirements.txt` (voce); ogni pacchetto porta il testo della sua licenza. Le versioni qui sotto sono quelle dei lockfile al momento della scrittura.

## Non coperto dalla licenza di Ciccio

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): software proprietario, © Anthropic PBC, tutti i diritti riservati. Si usa alle condizioni di Anthropic: le [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) e gli accordi elencati in [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance). Con `pnpm install` arriva da npm anche il programma di Claude Code per la piattaforma del server (`@anthropic-ai/claude-agent-sdk-linux-x64` e simili), che Ciccio lancia per ogni sessione. Non è nel repo: lo scarica chi installa.
- **Account Claude**: gli agenti funzionano solo con il login di un abbonamento claude.ai a pagamento (Pro, Max, Team o Enterprise), con le condizioni di Anthropic. Le chiavi API non si usano.

La licenza AGPL-3.0 di Ciccio vale per il codice di Ciccio, non per questi componenti.

## Codice adattato

### prompt-kit (MIT)

Componenti dell'interfaccia delle chat ripresi da [prompt-kit](https://www.prompt-kit.com) ([sorgente](https://github.com/ibelick/prompt-kit)) e riscritti senza shadcn, nello stile di Ciccio. Ogni file lo dice in un commento in cima:

- `web/src/chat/ChatContainer.tsx` (ChatContainer, ScrollButton)
- `web/src/chat/FileUpload.tsx` (FileUpload)
- `web/src/chat/Image.tsx` (Image)
- `web/src/chat/Reasoning.tsx` (Reasoning, TextShimmer, ThinkingBar; la barra la usa anche `web/src/chat/Transcript.tsx`)
- `web/src/chat/Source.tsx` (Source)
- `web/src/chat/Steps.tsx` (Steps, Chain of thought)
- `web/src/chat/SystemMessage.tsx` (SystemMessage)
- `web/src/chat/Tool.tsx` (Tool)

```
MIT License

Copyright (c) 2025 Julien Thibeaut

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Icone: Lucide (ISC) e Feather (MIT)

Alcune icone SVG scritte direttamente nei componenti riprendono i tracciati di [Lucide](https://lucide.dev) o, per le icone che Lucide deriva da Feather, di [Feather](https://feathericons.com): per esempio la spunta (`M20 6 9 17l-5-5`), la croce, «copia» e «riduci» in `web/src/chat/CopyButton.tsx`, `web/src/chat/Markdown.tsx`, `web/src/chat/Tool.tsx` e `web/src/chat/SystemMessage.tsx`, l'ingranaggio in `web/src/ui.tsx`. Le altre icone sono disegnate per Ciccio. Licenza di Lucide, che comprende quella di Feather:

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Caratteri (OFL-1.1)

L'interfaccia compilata include questi caratteri, dai pacchetti [Fontsource](https://fontsource.org) (`@fontsource/geist`, `@fontsource/geist-mono`, `@fontsource/silkscreen`, 5.3.0), senza modifiche:

- **Geist** e **Geist Mono**: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)
- **Silkscreen**: Copyright 2001 The Silkscreen Project Authors (https://github.com/googlefonts/silkscreen)

```
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## Dipendenze con licenze non permissive o doppie

Tutte usate senza modifiche; il sorgente è quello del pacchetto indicato (npm, crates.io o PyPI).

### Interfaccia web (nel codice compilato che il browser scarica)

| Pacchetto | Versione | Licenza | Dove |
| - | - | - | - |
| [DOMPurify](https://github.com/cure53/DOMPurify) (`dompurify`) | 3.4.17 | MPL-2.0 OR Apache-2.0, © Cure53 and other contributors | pulizia dell'HTML delle risposte (Markdown) e dentro mermaid |
| [elkjs](https://github.com/kieler/elkjs) | 0.9.3 | EPL-2.0 | layout dei diagrammi di mermaid (file `elk-*.js`, caricato solo quando serve) |
| [JSZip](https://github.com/Stuk/jszip) (`jszip`) | 3.10.2 | MIT OR GPL-3.0-or-later | dentro mammoth (anteprima dei .docx) |
| [pako](https://github.com/nodeca/pako) | 1.0.11 | MIT AND Zlib | dentro JSZip |
| [duck](https://github.com/mwilliamson/duck) | 0.1.12 | BSD-2-Clause, © 2013 Michael Williamson | dentro mammoth |

Solo per compilare (non finisce nel Ciccio compilato): `lightningcss` (MPL-2.0), usato da Tailwind e Vite.

### App desktop (Rust)

Crate con licenza MPL-2.0, compilati nell'app senza modifiche (arrivano da Tauri e WRY): `cssparser` 0.37.0, `cssparser-macros` 0.7.1, `selectors` 0.38.0, `dtoa-short` 0.3.5, `option-ext` 0.2.0. Sorgenti su [crates.io](https://crates.io). L'installer di Windows, se manca WebView2, lo scarica da Microsoft.

### Companion

L'eseguibile del companion (Windows) e il programma dentro l'app del Mac sono compilati con [Bun](https://bun.com) (`bun build --compile`) e contengono il suo runtime: Bun è MIT e include in modo statico JavaScriptCore e parti di WebKit (LGPL-2.0) e altre librerie con le loro licenze. Elenco, licenze e come ricompilarlo: [Bun › Licensing](https://bun.com/docs/project/licensing).

### Voce sul server (facoltativa)

Installata a parte da `deploy/install-voice.sh`, in un ambiente Python suo, come servizio separato (`voice/service.py`, raggiunto da Ciccio in HTTP su 127.0.0.1):

| Pacchetto | Versione | Licenza |
| - | - | - |
| [piper-tts](https://github.com/OHF-Voice/piper1-gpl) | 1.8.0 | GPL-3.0-or-later; include espeak-ng (GPL-3.0-or-later) |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 1.2.1 | MIT |

I modelli li scarica `setup.sh --step voce` e non sono nel repo: Whisper base ([Systran/faster-whisper-base](https://huggingface.co/Systran/faster-whisper-base), MIT) e le voci italiane di Piper ([rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices), `it_IT-paola-medium` e `it_IT-riccardo-x_low`), ognuna con le condizioni indicate nella sua scheda.
