#!/bin/sh
set -eu
ESCROW_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ESCROW_CACHE="$ESCROW_ROOT/../../contracts/registry/.toolchain"
export RUSTUP_HOME="$ESCROW_CACHE/rustup"
export CARGO_HOME="$ESCROW_CACHE/cargo"
export CARGO_TARGET_DIR="$ESCROW_ROOT/../testnet_escrow/target"
export CARGO_BUILD_JOBS=1
ESCROW_TC="$RUSTUP_HOME/toolchains/1.98.0-aarch64-apple-darwin"
export PATH="$ESCROW_TC/bin:$PATH"
export DYLD_FALLBACK_LIBRARY_PATH="$ESCROW_TC/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
cd "$ESCROW_ROOT"
exec cargo "$@"
