#!/usr/bin/env bash
# Builds a tmux for the app bundle: libevent and utf8proc linked in statically, the system's ncurses, so the
# binary needs nothing outside macOS. Usage: macos/build-tmux.sh <arm64|x86_64> <out-file>
set -euo pipefail
ARCH="$1"; OUT="$2"
TMUX_VERSION=3.8;               TMUX_SHA=e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e
LIBEVENT_VERSION=2.1.13-stable; LIBEVENT_SHA=f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c
UTF8PROC_VERSION=2.12.0;        UTF8PROC_SHA=a393fbef160835fb315bc3e91ba8d86f7a73a7cec9e6198b6c60b848b498bfeb

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/build/macos/tmux-$ARCH"
CACHE="$ROOT/build/macos/downloads"
PREFIX="$WORK/prefix"
mkdir -p "$WORK" "$CACHE" "$PREFIX"
: >"$WORK/build.log"

fetch() { # url sha256 -> path of the verified tarball
  local file="$CACHE/$(basename "$1")"
  if [ ! -f "$file" ]; then curl -fsSL -o "$file.part" "$1"; mv "$file.part" "$file"; fi
  echo "$2  $file" | shasum -a 256 -c - >/dev/null || { echo "checksum mismatch: $file" >&2; rm -f "$file"; exit 1; }
  echo "$file"
}
# Compiler output goes to a log; it's shown only when a step fails.
run() { "$@" >>"$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log" >&2; echo "failed: $*" >&2; exit 1; }; }
unpack() { rm -rf "$WORK/$2"; tar -xzf "$1" -C "$WORK"; }

export MACOSX_DEPLOYMENT_TARGET=13.0
export CC="clang -arch $ARCH"
export CFLAGS="-O2 -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
HOST="$([ "$ARCH" = arm64 ] && echo aarch64 || echo x86_64)-apple-darwin"
JOBS="$(sysctl -n hw.ncpu)"

f=$(fetch "https://github.com/libevent/libevent/releases/download/release-$LIBEVENT_VERSION/libevent-$LIBEVENT_VERSION.tar.gz" "$LIBEVENT_SHA")
unpack "$f" "libevent-$LIBEVENT_VERSION"
cd "$WORK/libevent-$LIBEVENT_VERSION"
run ./configure --host="$HOST" --prefix="$PREFIX" --enable-static --disable-shared --disable-openssl --disable-samples --disable-libevent-regress
run make -j"$JOBS"
run make install

f=$(fetch "https://github.com/JuliaStrings/utf8proc/releases/download/v$UTF8PROC_VERSION/utf8proc-$UTF8PROC_VERSION.tar.gz" "$UTF8PROC_SHA")
unpack "$f" "utf8proc-$UTF8PROC_VERSION"
cd "$WORK/utf8proc-$UTF8PROC_VERSION"
run make -j"$JOBS" libutf8proc.a CC="$CC" CFLAGS="$CFLAGS"
mkdir -p "$PREFIX/lib" "$PREFIX/include" && cp libutf8proc.a "$PREFIX/lib/" && cp utf8proc.h "$PREFIX/include/"

f=$(fetch "https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz" "$TMUX_SHA")
unpack "$f" "tmux-$TMUX_VERSION"
# Only the static libraries are in PREFIX, so the linker can't pick a dylib from Homebrew instead.
cd "$WORK/tmux-$TMUX_VERSION"
run ./configure --host="$HOST" --enable-utf8proc --disable-jemalloc \
  LIBEVENT_CFLAGS="-I$PREFIX/include" LIBEVENT_LIBS="$PREFIX/lib/libevent_core.a" \
  LIBUTF8PROC_CFLAGS="-I$PREFIX/include -DUTF8PROC_STATIC" LIBUTF8PROC_LIBS="$PREFIX/lib/libutf8proc.a" \
  LIBNCURSES_CFLAGS="" LIBNCURSES_LIBS="-lncurses" PKG_CONFIG=/usr/bin/false
run make -j"$JOBS"
cd "$ROOT"
mkdir -p "$(dirname "$OUT")"
cp "$WORK/tmux-$TMUX_VERSION/tmux" "$OUT"
strip "$OUT"
# Nothing but system libraries may be linked.
if otool -L "$OUT" | tail -n +2 | grep -v -E '^\s+/(usr/lib|System)/'; then echo "tmux links a non-system library" >&2; exit 1; fi
echo "built $OUT (tmux $TMUX_VERSION, $ARCH)"
