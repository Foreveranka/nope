#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEFAULT_PYTHON="$ROOT/.venv/bin/python"
if [ ! -x "$DEFAULT_PYTHON" ]; then
  DEFAULT_PYTHON='/Users/mete/Desktop/NEAR-Hackathon-2026-Arastirma/Gizli-Is-Pazari-Fizibilite/Sifresini-Acmadan-Hesaplama/Deney/.venv/bin/python'
fi
VEIL_PYTHON=${VEIL_PYTHON:-$DEFAULT_PYTHON}
if [ ! -x "$VEIL_PYTHON" ]; then
  printf '%s\n' 'Concrete Python ortamı bulunamadı; VEIL_PYTHON ayarlayın.' >&2
  exit 1
fi
if [ ! -x "$ROOT/contracts/registry/target/debug/registry-sandbox-driver" ]; then
  printf '%s\n' 'Önce registry Wasm ve yerel sandbox driver derlenmeli; integration/README.md dosyasına bakın.' >&2
  exit 1
fi
cd "$ROOT"
# Existing Apple cache avoids slow Desktop/iCloud bytecode reads. No cache writes.
VEIL_PYCACHE=${VEIL_PYCACHE:-/Users/mete/Library/Caches/com.apple.python}
if [ -d "$VEIL_PYCACHE" ]; then
  exec "$VEIL_PYTHON" -B -X "pycache_prefix=$VEIL_PYCACHE" -m integration.run "$@"
fi
exec "$VEIL_PYTHON" -B -m integration.run "$@"
