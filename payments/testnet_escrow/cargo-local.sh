#!/bin/sh
set -eu
PAYMENT_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REGISTRY_CACHE="$PAYMENT_ROOT/../../contracts/registry/.toolchain"
export RUSTUP_HOME="$REGISTRY_CACHE/rustup"
export CARGO_HOME="$REGISTRY_CACHE/cargo"
export CARGO_TARGET_DIR="$PAYMENT_ROOT/target"
export CARGO_BUILD_JOBS=1
PAYMENT_TC="$RUSTUP_HOME/toolchains/1.98.0-aarch64-apple-darwin"
export PATH="$PAYMENT_TC/bin:$PATH"
export DYLD_FALLBACK_LIBRARY_PATH="$PAYMENT_TC/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
cd "$PAYMENT_ROOT"
exec cargo "$@"
