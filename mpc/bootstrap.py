#!/usr/bin/env python3
"""Build pinned native dependencies under mpc/.local and mpc/vendor only.

macOS ARM64; reads existing Homebrew GMP/OpenSSL, never installs with brew.
At most two compile jobs, one for the large MP-SPDZ template translation units.
No Docker, fake preprocessing, KOS override or INSECURE build flag.
"""
import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mpc.auction import UPSTREAM

ROOT = Path(__file__).resolve().parent
LOCAL = ROOT / ".local"
PREFIX = LOCAL / "prefix"
VENDOR = ROOT / "vendor/MP-SPDZ"
SOURCES = {
    "boost_1_86_0.tar.bz2": (
        "https://archives.boost.io/release/1.86.0/source/boost_1_86_0.tar.bz2",
        "1bed88e40401b2cb7a1f76d4bab499e352fa4d0c5f31c0dbae64e24d34d7513b"),
    "libsodium-1.0.20.tar.gz": (
        "https://download.libsodium.org/libsodium/releases/libsodium-1.0.20.tar.gz",
        "ebb65ef6ca439333c2bb41a0c1990587288da07f6c7fd07cb3a18cc18d30ce19"),
}
PATCHED_FILES = ("Networking/Player.cpp", "Networking/ServerSocket.cpp", "Networking/ssl_sockets.h",
                 "Processor/ExternalClients.cpp", "Processor/OnlineOptions.cpp", "Tools/NetworkOptions.cpp")
PATCH_HEADER = "Networking/VeilBind.h"


def transport_diff():
    # Index state is not an approval channel. In particular, a staged Makefile
    # change is invisible to plain `git diff` and must never reach make/stamping.
    git_diff = ["git", "diff", "--no-ext-diff", "--no-textconv"]
    staged = subprocess.run(git_diff+["--cached", "--quiet", "HEAD", "--"], cwd=VENDOR,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if staged.returncode != 0:
        raise RuntimeError("staged vendor changes or unreadable vendor index are forbidden")
    names = subprocess.check_output(git_diff+["--name-only", "-z", "HEAD", "--"], cwd=VENDOR)
    changes = {os.fsdecode(p) for p in names.split(b"\0") if p}
    if changes - set(PATCHED_FILES):
        raise RuntimeError("unexpected tracked native source changes")
    # Compare actual tracked bytes/modes with HEAD, even if index flags or stat
    # caching hide a change from Git's worktree diff. Do not refresh/mutate index.
    tree = subprocess.check_output(["git", "ls-tree", "-r", "-z", "HEAD"], cwd=VENDOR)
    for entry in tree.split(b"\0"):
        if not entry:
            continue
        metadata, raw_name = entry.split(b"\t", 1)
        mode, kind, object_id = metadata.split()
        if kind != b"blob":
            continue
        name = os.fsdecode(raw_name)
        path = VENDOR / name
        try:
            info = path.lstat()
            if mode == b"120000" and stat.S_ISLNK(info.st_mode):
                contents = os.fsencode(os.readlink(path))
                actual_mode = b"120000"
            elif mode in (b"100644", b"100755") and stat.S_ISREG(info.st_mode):
                contents = path.read_bytes()
                actual_mode = b"100755" if info.st_mode & 0o111 else b"100644"
            else:
                raise RuntimeError("tracked vendor file type differs from HEAD")
        except OSError:
            raise RuntimeError("tracked vendor contents are unreadable") from None
        blob = hashlib.sha1(b"blob " + str(len(contents)).encode() + b"\0" + contents).hexdigest().encode()
        if (blob != object_id or actual_mode != mode) and name not in changes:
            raise RuntimeError("hidden tracked vendor change differs from HEAD")
    diff = subprocess.check_output(git_diff+["HEAD", "--", *PATCHED_FILES], cwd=VENDOR)
    header = VENDOR / PATCH_HEADER
    if header.exists():
        extra = subprocess.run(["git", "diff", "--no-index", "--", "/dev/null", PATCH_HEADER],
                               cwd=VENDOR, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if extra.returncode != 1:
            raise RuntimeError("cannot verify native bind header")
        diff += extra.stdout
    return diff.decode().strip()


def check_transport_patch():
    patch = ROOT / "patches/local-transport.patch"
    diff = transport_diff()
    if not diff:
        run(["git", "apply", patch], VENDOR, "transport-patch")
    if transport_diff() != patch.read_text().strip():
        raise RuntimeError("unexpected vendor transport changes")


def record_native_build(stamp, *, mode):
    # Do not certify a build if vendor/index inputs changed while make ran.
    check_transport_patch()
    stamp.update(upstream=UPSTREAM, transportPatchSha256=sha(ROOT / "patches/local-transport.patch"),
                 configSha256=sha(VENDOR / "CONFIG.mine"), binarySha256=sha(VENDOR / "spdz2k-party.x"),
                 sharedLibrarySha256=sha(VENDOR / "libSPDZ.so"),
                 transportGeneration="explicit-bind-leaf-pin-v2", buildMode=mode,
                 nativePatchSourcesSha256={p: sha(VENDOR / p) for p in (*PATCHED_FILES, PATCH_HEADER)},
                 insecureFlags=False, livePreprocessing=True)
    (LOCAL / "build-stamp.json").write_text(json.dumps(stamp, indent=2) + "\n")
    (ROOT / "evidence/native-build.json").write_text(json.dumps(stamp, indent=2) + "\n")
    print(json.dumps(stamp, indent=2))


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def run(command, cwd=ROOT, log="bootstrap", env=None):
    logs = LOCAL / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    print("Building/checking " + log, flush=True)
    with (logs / (log + ".log")).open("ab") as out:
        subprocess.run([str(x) for x in command], cwd=cwd, stdout=out,
                       stderr=subprocess.STDOUT, check=True, env=env)


def output(command, cwd=ROOT):
    return subprocess.check_output([str(x) for x in command], cwd=cwd, text=True).strip()


def disk_gate():
    size = sum(int(output(["du", "-sk", str(p)]).split()[0]) * 1024
               for p in (LOCAL, ROOT / "vendor") if p.exists())
    if size >= 2_000_000_000:
        raise RuntimeError("task dependency footprint exceeds 2 GB; stop before building more")
    return size


def download_extract(filename):
    url, expected = SOURCES[filename]
    target = LOCAL / "downloads" / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        temporary = target.with_suffix(target.suffix + ".part")
        with urllib.request.urlopen(url, timeout=60) as source, temporary.open("wb") as dest:
            received = 0
            while True:
                block = source.read(1024 * 1024)
                if not block:
                    break
                received += len(block)
                if received > 150_000_000:
                    raise RuntimeError("unexpected dependency archive size")
                dest.write(block)
        temporary.rename(target)
    if sha(target) != expected:
        raise RuntimeError("dependency SHA-256 mismatch: " + filename)
    src = LOCAL / "src"
    src.mkdir(exist_ok=True)
    with tarfile.open(target) as archive:
        # Release archives are pinned by SHA and still checked for traversal.
        for entry in archive.getmembers():
            if not (src / entry.name).resolve().is_relative_to(src.resolve()):
                raise RuntimeError("unsafe archive member")
        archive.extractall(src)
    return src


def native_config():
    return f'''# Local ARM prototype, active security checks retained.
CXX = /usr/bin/clang++
ARCH = -march=armv8.2-a+crypto
OPTIM = -O1
GDEBUG = -g0
USE_KOS = 0
USE_LIBOTE2 = 1
BREW_CFLAGS = -I/opt/homebrew/opt/gmp/include -I/opt/homebrew/opt/openssl@3/include -I{PREFIX}/include
BREW_LDLIBS = -L/opt/homebrew/opt/gmp/lib -L/opt/homebrew/opt/openssl@3/lib -L{PREFIX}/lib
OTE_OPTS += --par=2 -DENABLE_BOOST=ON -DFETCH_BOOST=OFF -DCOPROTO_FETCH_BOOST=OFF -DBOOST_ROOT={PREFIX} -DCMAKE_PREFIX_PATH={PREFIX}
MY_CFLAGS += -Wno-error=deprecated-literal-operator -Wno-error=unused-parameter
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, choices=(1, 2), default=2)
    parser.add_argument("--native-only", action="store_true",
                        help="rebuild existing verified native setup with -j1; no dependency installation")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("this bootstrap is specifically tested for macOS arm64")
    if args.native_only:
        stamp = json.loads((LOCAL / "build-stamp.json").read_text())
        if (output(["git", "rev-parse", "HEAD"], VENDOR) != UPSTREAM or
                (VENDOR / "CONFIG.mine").read_text() != native_config() or
                stamp.get("insecureFlags") is not False or stamp.get("livePreprocessing") is not True):
            raise RuntimeError("native-only requires the existing approved secure setup")
        check_transport_patch()
        disk_gate()
        run(["make", "-j1", "spdz2k-party.x"], VENDOR, "explicit-bind-native")
        record_native_build(stamp, mode="native-only")
        return
    for dependency in ("/opt/homebrew/opt/gmp/include/gmpxx.h",
                       "/opt/homebrew/opt/openssl@3/include/openssl/ssl.h"):
        if not Path(dependency).exists():
            raise RuntimeError("required existing dependency absent: " + dependency)
    LOCAL.mkdir(exist_ok=True)
    PREFIX.mkdir(exist_ok=True)
    (ROOT / "vendor").mkdir(exist_ok=True)
    if not VENDOR.exists():
        run(["git", "init", VENDOR], log="checkout")
        run(["git", "remote", "add", "origin", "https://github.com/data61/MP-SPDZ.git"], VENDOR, "checkout")
        run(["git", "fetch", "--depth", "1", "origin", UPSTREAM], VENDOR, "checkout")
        run(["git", "checkout", "--detach", "FETCH_HEAD"], VENDOR, "checkout")
    if output(["git", "rev-parse", "HEAD"], VENDOR) != UPSTREAM:
        raise RuntimeError("refusing to replace a different vendor checkout")
    patch = ROOT / "patches/local-transport.patch"
    check_transport_patch()
    run(["git", "submodule", "update", "--init", "--depth", "1",
         "deps/SimplestOT_C", "deps/simde", "deps/sse2neon", "deps/libOTe2", "Programs/Circuits"], VENDOR, "submodules")
    ote = VENDOR / "deps/libOTe2"
    run(["git", "submodule", "update", "--init", "--depth", "1", "cryptoTools"], ote, "submodules")
    if not (LOCAL / "python/cmake").exists():
        run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir",
             "--target", LOCAL / "python", "cmake==3.31.10"], log="cmake")
    cmake = LOCAL / "python/cmake/data/bin/cmake"
    env = dict(os.environ, CMAKE_BUILD_PARALLEL_LEVEL=str(args.jobs))
    env["PATH"] = str(cmake.parent) + os.pathsep + env["PATH"]
    if not (PREFIX / "lib/libsodium.a").exists():
        src = download_extract("libsodium-1.0.20.tar.gz") / "libsodium-1.0.20"
        run(["./configure", "--prefix=" + str(PREFIX), "--disable-shared"], src, "libsodium")
        run(["make", "-j" + str(args.jobs)], src, "libsodium")
        run(["make", "check", "-j1"], src, "libsodium")
        run(["make", "install"], src, "libsodium")
        shutil.rmtree(src)
    if not (PREFIX / "lib/libboost_regex.a").exists():
        src = download_extract("boost_1_86_0.tar.bz2") / "boost_1_86_0"
        run(["./bootstrap.sh", "--prefix=" + str(PREFIX)], src, "boost")
        run(["./b2", "-j" + str(args.jobs), "--with-filesystem", "--with-iostreams", "--with-thread",
             "--with-system", "--with-regex", "--with-chrono", "--with-atomic", "--with-date_time",
             "cxxstd=20", "variant=release", "link=static", "threading=multi", "--layout=system",
             "--prefix=" + str(PREFIX), "install"], src, "boost")
        shutil.rmtree(src)  # avoid retaining ~1 GB of unneeded release sources
    disk_gate()
    config = VENDOR / "CONFIG.mine"
    if not config.exists() or config.read_text() != native_config():
        config.write_text(native_config())
    build = ote / "out/build/osx"
    run([cmake, "-S", ote, "-B", build, "-DCMAKE_INSTALL_PREFIX=" + str(VENDOR / "local"),
         "-DENABLE_SOFTSPOKEN_OT=ON", "-DENABLE_SILENTOT=ON", "-DENABLE_PORTABLE_AES=ON",
         "-DENABLE_AVX=OFF", "-DENABLE_SSE=OFF", "-DENABLE_BOOST=ON", "-DFETCH_BOOST=OFF",
         "-DCOPROTO_FETCH_BOOST=OFF", "-DFETCH_COPROTO=ON", "-DFETCH_AUTO=ON",
         "-DPARALLEL_FETCH=" + str(args.jobs), "-DBOOST_ROOT=" + str(PREFIX),
         "-DCMAKE_PREFIX_PATH=" + str(PREFIX), "-DCMAKE_CXX_COMPILER=/usr/bin/clang++",
         "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_INSTALL_LIBDIR=lib",
         "-DCMAKE_CXX_FLAGS=-Wno-error=unused-local-typedef -I" + str(VENDOR / "deps")],
        ote, "libote", env)
    run([cmake, "--build", build, "--parallel", str(args.jobs)], ote, "libote", env)
    run([cmake, "--install", build], ote, "libote", env)
    run([cmake, "-S", VENDOR / "deps/SimplestOT_C/ref10", "-B", VENDOR / "deps/SimplestOT_C/ref10",
         "-DOC_THIRDPARTY_HINT=" + str(PREFIX)], VENDOR, "simplestot", env)
    (VENDOR / "local/lib/liblibOTe.a").touch()  # explicit bounded build above satisfies make dependency
    disk_gate()
    check_transport_patch()
    run(["make", "-j1", "spdz2k-party.x"], VENDOR, "spdz2k", env)
    stamp = {"upstream": UPSTREAM, "transportPatchSha256": sha(patch),
             "configSha256": sha(config), "binarySha256": sha(VENDOR / "spdz2k-party.x"),
             "sharedLibrarySha256": sha(VENDOR / "libSPDZ.so"),
             "clang": output(["/usr/bin/clang++", "--version"]),
             "cmake": output([cmake, "--version"]), "python": sys.version,
             "dependencyArchives": SOURCES, "dependenciesBytes": disk_gate(),
             "insecureFlags": False, "livePreprocessing": True,
             "submodules": output(["git", "submodule", "status"], VENDOR),
             "liboteTransitiveCommits": {name: output(["git", "rev-parse", "HEAD"], ote / "out" / name)
                                        for name in ("coproto", "macoro", "function2")}}
    record_native_build(stamp, mode="full-bootstrap")


if __name__ == "__main__":
    main()
