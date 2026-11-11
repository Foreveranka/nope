#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEFAULT_PYTHON="$ROOT/.venv/bin/python"
if [ ! -x "$DEFAULT_PYTHON" ]; then
  DEFAULT_PYTHON='/Users/mete/Desktop/NEAR-Hackathon-2026-Arastirma/Gizli-Is-Pazari-Fizibilite/Sifresini-Acmadan-Hesaplama/Deney/.venv/bin/python'
fi
VEIL_PYTHON=${VEIL_PYTHON:-$DEFAULT_PYTHON}
if [ ! -x "$VEIL_PYTHON" ]; then
  printf '%s\n' 'Concrete Python çalışma ortamı bulunamadı. VEIL_PYTHON değişkenini ayarlayın.' >&2
  exit 1
fi
cd "$ROOT"
VEIL_PYCACHE=${VEIL_PYCACHE:-/Users/mete/Library/Caches/com.apple.python}
if [ -d "$VEIL_PYCACHE" ]; then
  exec "$VEIL_PYTHON" -B -X "pycache_prefix=$VEIL_PYCACHE" -m service.server --port "${VEIL_PORT:-8765}"
fi
exec "$VEIL_PYTHON" -B -m service.server --port "${VEIL_PORT:-8765}"
