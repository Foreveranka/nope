#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  sh install-client.sh
fi
exec .venv/bin/python scripts/client-launch.py
