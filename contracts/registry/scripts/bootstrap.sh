#!/bin/sh
set -eu
REGISTRY_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
export RUSTUP_HOME="$REGISTRY_ROOT/.toolchain/rustup"
export CARGO_HOME="$REGISTRY_ROOT/.toolchain/cargo"
# Uses the existing rustup executable; does not modify global profiles/defaults.
exec rustup toolchain install 1.98.0 --profile minimal --component rustfmt --component clippy --target wasm32-unknown-unknown --no-self-update
