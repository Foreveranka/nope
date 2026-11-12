#!/bin/sh
set -eu
CSV_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
export RUSTUP_HOME="$CSV_ROOT/../registry/.toolchain/rustup"
export CARGO_HOME="$CSV_ROOT/../registry/.toolchain/cargo"
export CARGO_TARGET_DIR="$CSV_ROOT/target"
export CARGO_BUILD_JOBS=1
CSV_TC="$RUSTUP_HOME/toolchains/1.98.0-aarch64-apple-darwin"
export PATH="$CSV_TC/bin:$PATH"
export DYLD_FALLBACK_LIBRARY_PATH="$CSV_TC/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
cd "$CSV_ROOT"
exec cargo "$@"
