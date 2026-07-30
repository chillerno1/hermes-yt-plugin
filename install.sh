#!/usr/bin/env bash
# Install hermes-yt-plugin into the active Hermes home (default ~/.hermes).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

SRC="$ROOT/desktop-plugins/hermes-yt-plugin"
DST="$HERMES_HOME/desktop-plugins/hermes-yt-plugin"
LEGACY_DST="$HERMES_HOME/desktop-plugins/media-overlay"

if [[ ! -f "$SRC/plugin.js" ]]; then
  echo "error: missing $SRC/plugin.js" >&2
  exit 1
fi

mkdir -p "$HERMES_HOME/desktop-plugins"
rm -rf "$DST" "$LEGACY_DST"
mkdir -p "$DST"
cp -R "$SRC/." "$DST/"

echo "Installed desktop plugin → $DST"
cat <<'EOF'

This is a UI-only plugin: no backend, no plugin.yaml, nothing to enable.
Hermes fs-watches the desktop-plugins directory, so it loads on the change
tick — no dashboard restart and no "Reload desktop plugins" needed.

Look for the floating "YouTube" card (bottom-right) and the status-bar chip.
EOF
