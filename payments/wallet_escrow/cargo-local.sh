#!/bin/sh
set -eu
WALLET_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
export RUSTUP_HOME="$WALLET_ROOT/../../contracts/registry/.toolchain/rustup"
export CARGO_HOME="$WALLET_ROOT/../../contracts/registry/.toolchain/cargo"
# Reuse the already-built, ignored native/sandbox dependencies; no second GB cache.
export CARGO_TARGET_DIR="$WALLET_ROOT/../testnet_escrow/target"
export CARGO_BUILD_JOBS=1
WALLET_TC="$RUSTUP_HOME/toolchains/1.98.0-aarch64-apple-darwin"
export PATH="$WALLET_TC/bin:$PATH"
export DYLD_FALLBACK_LIBRARY_PATH="$WALLET_TC/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
cd "$WALLET_ROOT"
exec cargo "$@"
