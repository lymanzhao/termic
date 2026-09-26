#!/usr/bin/env bash
# One-shot Windows dev setup, run from Git Bash. `make setup` calls this on
# Windows; run it directly (`bash scripts/setup-windows.sh`) when GNU make is
# not installed yet, since it installs make too.
#
# Installs what is missing, through winget, and skips what is there:
#   Visual Studio Build Tools (C++ workload), WebView2, Rust (rustup, MSVC
#   toolchain), Node 22, GNU make.
# Then: git core.longpaths, npm install, the e2e fixture seed, and a first
# cargo check.
#
# Never elevates on its own. The two machine-wide settings it cannot make as
# your user (Windows long paths, Developer Mode) are checked and reported
# with the exact command to run. It does set git's core.longpaths in your
# user's global git config.
#
# WITH_DOCKER=1 also installs Docker Desktop (large; only needed for the
# Docker sandbox).
set -euo pipefail

say()  { printf '→ %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) die "this is the Windows setup; on macOS and Linux run: make setup" ;;
esac

winget_install() { # <id> [extra winget args...]
  local id="$1"; shift
  # Only needed when something is actually missing, so a machine that has
  # everything (a CI runner, a returning developer) needs no winget at all.
  command -v winget >/dev/null 2>&1 \
    || die "$id is missing and winget is not available to install it. Install 'App Installer' from the Microsoft Store (or install $id by hand), then re-run."
  say "Installing $id (winget)"
  # winget exits non-zero for "already installed / no upgrade", which is fine.
  winget install --id "$id" --exact --silent \
    --accept-package-agreements --accept-source-agreements "$@" || true
}

# Pick up tools installed moments ago without a new shell: re-read the
# machine + user PATH from the registry, then add the well-known install
# dirs in case a fresh installer has not broadcast its PATH change yet.
refresh_path() {
  local reg
  reg="$(powershell -NoProfile -Command \
    "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')" \
    2>/dev/null | tr -d '\r')" || true
  if [ -n "$reg" ]; then
    PATH="$(cygpath -p "$reg"):$PATH"
  fi
  local d
  for d in "$HOME/.cargo/bin" "/c/Program Files/nodejs" \
           "$(cygpath -u "${LOCALAPPDATA:-C:\\}")/Microsoft/WinGet/Links"; do
    [ -d "$d" ] && PATH="$d:$PATH"
  done
  export PATH
  hash -r
}

VSWHERE="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
have_msvc() {
  [ -x "$VSWHERE" ] && [ -n "$("$VSWHERE" -latest -products '*' \
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 \
    -property installationPath 2>/dev/null | tr -d '\r')" ]
}

have_webview2() {
  local key='HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  reg query "$key" //v pv >/dev/null 2>&1 \
    || reg query 'HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' //v pv >/dev/null 2>&1
}

# The installed Node's major version, or 0 when there is none.
node_major() {
  local v
  v="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
  echo "${v:-0}"
}

echo "→ Termic dev environment bootstrap (Windows)"

# ── toolchains ────────────────────────────────────────────────────────────

if have_msvc; then
  ok "Visual Studio C++ build tools"
else
  winget_install Microsoft.VisualStudio.2022.BuildTools \
    --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  have_msvc || die "the C++ build tools did not install; install 'Desktop development with C++' from https://visualstudio.microsoft.com/visual-cpp-build-tools/ and re-run"
  ok "Visual Studio C++ build tools"
fi

if have_webview2; then
  ok "WebView2 runtime"
else
  winget_install Microsoft.EdgeWebView2Runtime
  ok "WebView2 runtime"
fi

if ! command -v rustup >/dev/null 2>&1 && ! command -v cargo >/dev/null 2>&1; then
  winget_install Rustlang.Rustup
  refresh_path
fi
command -v rustup >/dev/null 2>&1 || die "rustup is not on PATH after installing it; open a new Git Bash and re-run"
if ! rustup show active-toolchain >/dev/null 2>&1; then
  rustup default stable
fi
ok "rust ($(cargo --version))"

if [ "$(node_major)" -lt 22 ]; then
  winget_install OpenJS.NodeJS.22
  refresh_path
fi
[ "$(node_major)" -ge 22 ] \
  || die "Node 22+ is not on PATH after installing it; open a new Git Bash and re-run"
ok "node ($(node --version))"

if command -v make >/dev/null 2>&1; then
  ok "make"
else
  winget_install ezwinports.make
  refresh_path
  command -v make >/dev/null 2>&1 && ok "make" || warn "make installed; open a new Git Bash to use it"
fi

if [ "${WITH_DOCKER:-0}" = "1" ]; then
  if command -v docker >/dev/null 2>&1; then
    ok "docker"
  else
    winget_install Docker.DockerDesktop
    warn "Docker Desktop installed: start it once, use the WSL2 backend and Linux containers"
  fi
fi

# ── settings ─────────────────────────────────────────────────────────────

# Your user's git config: lets git handle worktree paths past 260 characters.
git config --global core.longpaths true
ok "git core.longpaths"

# Machine-wide, so reported rather than changed: they need an admin.

long="$(reg query 'HKLM\SYSTEM\CurrentControlSet\Control\FileSystem' //v LongPathsEnabled 2>/dev/null | grep -o '0x[0-9a-f]*' || true)"
if [ "$long" = "0x1" ]; then
  ok "Windows long paths"
else
  warn "Windows long paths are off. Worktrees with node_modules / target exceed 260 characters."
  warn "In an ADMIN PowerShell, then reboot:"
  warn "  New-ItemProperty HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force"
fi

dev="$(reg query 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' //v AllowDevelopmentWithoutDevLicense 2>/dev/null | grep -o '0x[0-9a-f]*' || true)"
if [ "$dev" = "0x1" ]; then
  ok "Developer Mode (real symlinks)"
else
  warn "Developer Mode is off: fine, links fall back to junctions and hard links."
  warn "For real symlinks: Settings, System, For developers, Developer Mode."
fi

# ── the repo ─────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."
say "Installing npm packages"
npm install --no-fund --no-audit
say "Seeding the e2e fixture profile"
node scripts/e2e-seed.mjs || true
say "Pre-fetching Rust crates (cargo check)"
(cd src-tauri && cargo check)

echo ""
echo "✓ Setup complete. Try: make dev"
