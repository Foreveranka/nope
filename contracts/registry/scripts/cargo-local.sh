#!/bin/sh
set -eu
REGISTRY_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
export RUSTUP_HOME="$REGISTRY_ROOT/.toolchain/rustup"
export CARGO_HOME="$REGISTRY_ROOT/.toolchain/cargo"
export CARGO_TARGET_DIR="$REGISTRY_ROOT/target"
export CARGO_BUILD_JOBS=1
REGISTRY_TC="$RUSTUP_HOME/toolchains/1.98.0-$(uname -m | sed 's/arm64/aarch64/')-apple-darwin"
if [ ! -x "$REGISTRY_TC/bin/cargo" ]; then
    echo 'Install the scoped toolchain first; see README.md.' >&2
    exit 1
fi
export PATH="$REGISTRY_TC/bin:$PATH"
# The macOS 1.98 distribution's rust-lld rpath omits the top-level LLVM library.
export DYLD_FALLBACK_LIBRARY_PATH="$REGISTRY_TC/lib${DYLD_FALLBACK_LIBRARY_PATH:+:$DYLD_FALLBACK_LIBRARY_PATH}"
cd "$REGISTRY_ROOT"
exec cargo "$@"
