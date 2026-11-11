#!/bin/sh
set -eu
cd "$(dirname "$0")"
PYTHON=${VEIL_PYTHON:-python3}
"$PYTHON" -c 'import sys,platform; assert (3,9)<=sys.version_info[:2]<=(3,12), "Use Python 3.9–3.12"; assert platform.system() in ("Darwin","Linux"), "This release supports macOS and Linux"'
"$PYTHON" -m venv .venv
if [ "$(uname -s)" = Linux ]; then
  .venv/bin/python -m pip install --only-binary=:all: torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
fi
.venv/bin/python -m pip install --only-binary=:all: concrete-python==2.11.0 numpy==1.26.4
printf '%s\n' 'Installed. Start with: .venv/bin/python scripts/client-launch.py'
