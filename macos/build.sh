#!/usr/bin/env bash
# Builds lofiwave.app and a DMG for each architecture: build/macos/lofiwave-<version>-<arch>.dmg
#
#   macos/build.sh                 # this Mac's architecture
#   ARCHS="arm64 x86_64" macos/build.sh
#
# The app carries bun, a tmux built from source (macos/build-tmux.sh) and lofiwave's source. Without SIGN_IDENTITY
# it is ad-hoc signed: fine on the Mac that built it, but a downloaded copy is blocked by Gatekeeper until
# `xattr -dr com.apple.quarantine /Applications/lofiwave.app`. For a DMG anyone can open:
#   SIGN_IDENTITY="Developer ID Application: Name (TEAMID)"   signs with the hardened runtime
#   NOTARY_PROFILE=<profile>   also notarizes and staples (xcrun notarytool store-credentials <profile> ...)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ARCHS="${ARCHS:-$(uname -m)}"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)"
BUN_VERSION=1.4.2
BUN_SHA_arm64=90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f
BUN_SHA_x86_64=80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012
OUT="$ROOT/build/macos"
CACHE="$OUT/downloads"
mkdir -p "$CACHE"

sign() { # file [entitlements]
  if [ -n "${SIGN_IDENTITY:-}" ]; then
    codesign --force --timestamp --options runtime ${2:+--entitlements "$2"} --sign "$SIGN_IDENTITY" "$1"
  else
    codesign --force --sign - "$1"
  fi
}

icon() { # -> $OUT/AppIcon.icns, from public/logo.png
  local set="$OUT/AppIcon.iconset"
  rm -rf "$set" && mkdir -p "$set"
  for s in 16 32 128 256 512; do
    sips -z $s $s public/logo.png --out "$set/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) public/logo.png --out "$set/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$set" -o "$OUT/AppIcon.icns"
}
icon

for ARCH in $ARCHS; do
  case "$ARCH" in arm64) BUN_ARCH=aarch64 ;; x86_64) BUN_ARCH=x64 ;; *) echo "unknown arch $ARCH (arm64 or x86_64)" >&2; exit 1 ;; esac
  echo "== $ARCH"
  APP="$OUT/$ARCH/lofiwave.app"
  rm -rf "$OUT/$ARCH" && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bin" "$APP/Contents/Resources/app"

  # bun, checked against the release's SHASUMS256
  zip="$CACHE/bun-$BUN_VERSION-darwin-$BUN_ARCH.zip"
  [ -f "$zip" ] || curl -fsSL -o "$zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-darwin-$BUN_ARCH.zip"
  sha_var="BUN_SHA_$ARCH"
  echo "${!sha_var}  $zip" | shasum -a 256 -c - >/dev/null || { echo "bun checksum mismatch" >&2; rm -f "$zip"; exit 1; }
  unzip -q -o -j "$zip" "bun-darwin-$BUN_ARCH/bun" -d "$APP/Contents/Resources/bin"

  # tmux (cached per arch; delete build/macos/out to rebuild it)
  [ -x "$OUT/out/tmux-$ARCH" ] || macos/build-tmux.sh "$ARCH" "$OUT/out/tmux-$ARCH"
  cp "$OUT/out/tmux-$ARCH" "$APP/Contents/Resources/bin/tmux"

  # lofiwave itself: no build step, no dependencies
  cp -R src public README.md LICENSE package.json "$APP/Contents/Resources/app/"

  # the launcher
  swiftc -O -target "$ARCH-apple-macos13.0" -o "$APP/Contents/MacOS/lofiwave" macos/Lofiwave.swift
  sed "s/__VERSION__/$VERSION/g" macos/Info.plist > "$APP/Contents/Info.plist"
  cp "$OUT/AppIcon.icns" "$APP/Contents/Resources/"

  # inside out: the helpers, then the app
  sign "$APP/Contents/Resources/bin/tmux"
  sign "$APP/Contents/Resources/bin/bun" macos/bun.entitlements
  sign "$APP"
  codesign --verify --strict "$APP"

  DMG="$OUT/lofiwave-$VERSION-$ARCH.dmg"
  stage="$OUT/$ARCH/dmg"
  mkdir -p "$stage" && cp -R "$APP" "$stage/" && ln -s /Applications "$stage/Applications"
  rm -f "$DMG"
  hdiutil create -quiet -volname lofiwave -srcfolder "$stage" -fs HFS+ -format UDZO "$DMG"
  if [ -n "${SIGN_IDENTITY:-}" ]; then
    codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
    if [ -n "${NOTARY_PROFILE:-}" ]; then
      xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
      xcrun stapler staple "$DMG"
    fi
  fi
  echo "built $DMG ($(du -h "$DMG" | cut -f1))"
done
