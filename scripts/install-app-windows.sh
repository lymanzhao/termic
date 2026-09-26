#!/usr/bin/env bash
# Windows half of scripts/install-app.sh: install a freshly built NSIS
# installer silently and launch the app. Run from Git Bash (`make install`,
# `make beta`).
#
# Usage: scripts/install-app-windows.sh [APP_NAME]
#   APP_NAME  productName: "Termic" (default) or "Termic Beta"
#
# NSIS installs per user (Tauri's default installMode, currentUser) into
# %LOCALAPPDATA%\<productName>, so no elevation prompt. Like the macOS
# script, it quits a running copy of THIS app first and never touches the
# other one: the shipped app and the beta share one data dir, and the second
# to start hands off to the first and exits (single instance).
set -euo pipefail

APP_NAME="${1:-Termic}"
BUNDLE_DIR="src-tauri/target/release/bundle/nsis"
# The newest `<productName>_<version>_x64-setup.exe`.
SETUP="$(ls -t "$BUNDLE_DIR/${APP_NAME}"_*-setup.exe 2>/dev/null | head -1 || true)"
if [ -z "$SETUP" ]; then
  echo "✗ build artifact missing: $BUNDLE_DIR/${APP_NAME}_*-setup.exe"
  exit 1
fi

# The installed exe is named after the product; older Tauri bundles used the
# crate name. Look in both install locations NSIS uses.
LOCALAPPDATA_U="$(cygpath -u "$LOCALAPPDATA")"
installed_exe() {
  local d
  for d in "$LOCALAPPDATA_U/$APP_NAME" "$LOCALAPPDATA_U/Programs/$APP_NAME"; do
    for e in "$APP_NAME.exe" "termic.exe"; do
      [ -f "$d/$e" ] && { echo "$d/$e"; return; }
    done
  done
  return 0
}

# Match the running process by its full path, not its image name: both the
# shipped app and the beta may be `termic.exe`, and killing by name would take
# down the other one, possibly with live agents in it.
ps_by_path() {
  powershell -NoProfile -Command \
    "Get-Process | Where-Object { \$_.Path -eq '$1' } | $2" 2>/dev/null
}
running() { [ -n "$(ps_by_path "$1" 'Select-Object -ExpandProperty Id')" ]; }

OLD="$(installed_exe)"
if [ -n "$OLD" ]; then
  OLD_W="$(cygpath -w "$OLD")"
  if running "$OLD_W"; then
    echo "→ Quitting running $APP_NAME"
    ps_by_path "$OLD_W" 'ForEach-Object { $_.CloseMainWindow() | Out-Null }' >/dev/null || true
    for _ in $(seq 1 20); do running "$OLD_W" || break; sleep 0.25; done
    if running "$OLD_W"; then
      echo "  · quit didn't take, killing it"
      ps_by_path "$OLD_W" 'Stop-Process -Force' >/dev/null || true
      sleep 1
    fi
  fi
fi

echo "→ Installing $SETUP (silent, per user)"
"$SETUP" //S

EXE="$(installed_exe)"
if [ -z "$EXE" ]; then
  echo "✗ installed, but could not find $APP_NAME.exe under %LOCALAPPDATA%"
  exit 1
fi
echo "→ Launching $EXE"
# `start` detaches it from this shell, so closing the terminal does not
# close the app.
cmd //c start "" "$(cygpath -w "$EXE")"
echo "✓ Installed $APP_NAME"
