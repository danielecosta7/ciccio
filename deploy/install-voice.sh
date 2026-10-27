#!/usr/bin/env bash
# Servizio voce di Ciccio (utente di Ciccio, senza sudo): ambiente Python, pacchetti da PyPI, servizio systemd utente.
# I modelli NON si scaricano da qui (il firewall in uscita non apre Hugging Face): li scarica root, a revisioni fisse
# e con l'impronta sha256 di ogni file, con sudo bash /usr/local/lib/ciccio/setup.sh --step voce (che poi lancia questo),
# in ~/.ciccio/voice-models/{whisper-base,piper} (Systran/faster-whisper-base, rhasspy/piper-voices it_IT).
set -euo pipefail
cd "$(dirname "$0")/.."
venv="$HOME/.ciccio/voice-venv"
models="$HOME/.ciccio/voice-models"

if [[ ! -x "$venv/bin/python" ]]; then
  if python3 -m venv "$venv" 2>/dev/null; then
    echo "ambiente Python creato con python3 -m venv"
  else
    # Senza python3-venv (serve sudo per installarlo) si usa uv, che porta il suo Python.
    if ! command -v uv >/dev/null && [[ ! -x "$HOME/.local/bin/uv" ]]; then
      curl -fsSL https://github.com/astral-sh/uv/releases/download/0.9.5/uv-x86_64-unknown-linux-gnu.tar.gz | tar -xz -C /tmp
      mkdir -p "$HOME/.local/bin" && mv /tmp/uv-x86_64-unknown-linux-gnu/uv "$HOME/.local/bin/uv"
    fi
    UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
    "$UV" venv --python 3.12 "$venv"
  fi
fi
if [[ -x "$venv/bin/pip" ]]; then "$venv/bin/pip" install -q --upgrade pip && "$venv/bin/pip" install -q -r voice/requirements.txt
else "$(command -v uv || echo "$HOME/.local/bin/uv")" pip install -q --python "$venv/bin/python" -r voice/requirements.txt; fi

for f in whisper-base/model.bin piper/it_IT-paola-medium.onnx; do
  [[ -f "$models/$f" ]] || { echo "Manca il modello $models/$f: li scarica, come root, sudo bash /usr/local/lib/ciccio/setup.sh --step voce." >&2; exit 1; }
done

mkdir -p "$HOME/.config/systemd/user"
cp deploy/ciccio-voice.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now ciccio-voice
systemctl --user restart ciccio-voice
echo "servizio voce attivo"
