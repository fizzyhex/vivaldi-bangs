#!/usr/bin/env bash
# Installs (or removes) Helium-style !bangs into Vivaldi's browser UI on Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/fizzyhex/vivaldi-bangs/main/install.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/fizzyhex/vivaldi-bangs/main/install.sh | sudo bash -s -- --uninstall
#
# Vivaldi replaces these files on every update, so run this again after
# updating Vivaldi, then restart Vivaldi. Set VIVALDI_DIR for a non-standard
# install location.
set -euo pipefail

MOD=helium-bangs.js
TAG="<script src=\"$MOD\"></script>"
SOURCE="${BANGS_SOURCE:-https://raw.githubusercontent.com/fizzyhex/vivaldi-bangs/main/$MOD}"

die() { echo "error: $*" >&2; exit 1; }

dir="${VIVALDI_DIR:-}"
if [ -z "$dir" ]; then
  for candidate in /opt/vivaldi /opt/vivaldi-snapshot; do
    if [ -f "$candidate/resources/vivaldi/window.html" ]; then dir="$candidate"; break; fi
  done
fi
[ -n "$dir" ] || die "Vivaldi not found in /opt/vivaldi (set VIVALDI_DIR). Snap and Flatpak installs aren't supported."
res="$dir/resources/vivaldi"
html="$res/window.html"
[ -f "$html" ] || die "$html not found."
[ -w "$res" ] || die "No write access to $res. Run with sudo."

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$res/$MOD"
  sed -i "/$MOD/d" "$html"
  echo "Removed !bangs from $dir. Restart Vivaldi."
  exit 0
fi

# Use a copy next to this script if there is one, otherwise download it.
here="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/$MOD" ]; then
  cp "$here/$MOD" "$res/$MOD"
else
  echo "Downloading $MOD..."
  tmp="$(mktemp)"
  curl -fsSL "$SOURCE" -o "$tmp" || { rm -f "$tmp"; die "download of $MOD failed."; }
  [ "$(wc -c < "$tmp")" -gt 1000 ] || { rm -f "$tmp"; die "download of $MOD failed."; }
  install -m 644 "$tmp" "$res/$MOD"
  rm -f "$tmp"
fi

if ! grep -q "$MOD" "$html"; then
  [ -f "$html.bak" ] || cp "$html" "$html.bak"
  grep -q '</body>' "$html" || die "unexpected window.html layout; not patching."
  sed -i "s#</body>#  $TAG\n</body>#" "$html"
fi

echo "Installed !bangs into $dir. Restart Vivaldi to load it."
