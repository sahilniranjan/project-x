#!/bin/bash
# ProjectX.command — double-click launcher for the project-x web control panel.
#
# Starts the local Next.js panel (web/) and opens it in your browser.
# Close this Terminal window, or press Ctrl-C, to stop it.
#
# This file is not part of upstream project-x; it is local to this checkout and
# is left alone by `npm run update`.

set -uo pipefail
set -m   # own process group per background job, so cleanup can kill the whole tree

# prod (default) serves the compiled build: no Turbopack watcher, no HMR, no
# on-demand compilation. `next dev` was OOM-killed twice on this machine under
# swap pressure, and none of what it costs is useful when you are USING the
# panel rather than editing it.
#   ./ProjectX.command          -> production (default)
#   ./ProjectX.command dev      -> dev server (hot reload, heavy)
#   ./ProjectX.command rebuild  -> recompile, then production
MODE="${1:-prod}"

MIN_NODE_MAJOR=22
BASE_PORT=3000
PORT_TRIES=10

die() {
  printf '\n\033[31m✗ %s\033[0m\n\n' "$1" >&2
  printf 'Press return to close this window.\n' >&2
  read -r _
  exit 1
}

# --- Locate this script, following a Desktop symlink back to the real checkout ---
resolve_dir() {
  local src="${BASH_SOURCE[0]}" dir
  while [ -L "$src" ]; do
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    [[ $src != /* ]] && src="$dir/$src"
  done
  (cd -P "$(dirname "$src")" && pwd)
}
ROOT="$(resolve_dir)"
[ -d "$ROOT/web" ] || die "Can't find the web/ folder next to this launcher (looked in $ROOT)."

# --- Resolve Node explicitly. A double-clicked .command does NOT source ~/.zshrc,
#     so an nvm-managed node is invisible unless we go find it. ---
node_major() { "$1" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

pick_node() {
  local c maj
  local -a candidates=()
  command -v node >/dev/null 2>&1 && candidates+=("$(command -v node)")
  while IFS= read -r c; do candidates+=("$c"); done < <(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -r)
  candidates+=(/opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node)
  for c in "${candidates[@]}"; do
    [ -x "$c" ] || continue
    maj="$(node_major "$c")"
    [ -n "$maj" ] && [ "$maj" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null && { printf '%s' "$c"; return 0; }
  done
  return 1
}

NODE_BIN="$(pick_node)" || die "project-x needs Node ${MIN_NODE_MAJOR} or newer, and I couldn't find it.
  Looked on PATH, in ~/.nvm/versions/node/, /opt/homebrew/bin and /usr/local/bin.
  Install Node ${MIN_NODE_MAJOR}+ (https://nodejs.org) and double-click this again."

PATH="$(dirname "$NODE_BIN"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
export PROJECT_X_ROOT="$ROOT"

# --- Port selection. Reuse a panel that's already running; step over anything else. ---
#     Probe over 127.0.0.1, but hand the BROWSER "localhost": Next dev only treats
#     localhost as a trusted dev origin, and refuses to serve /_next/static chunks
#     to a page loaded from 127.0.0.1. Both satisfy web/src/lib/origin-guard.mjs.
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
is_our_panel() { curl -sf --max-time 2 "http://127.0.0.1:$1/api/version" 2>/dev/null | grep -q coreVersion; }

PORT=""
for ((p = BASE_PORT; p < BASE_PORT + PORT_TRIES; p++)); do
  if ! port_busy "$p"; then PORT="$p"; break; fi
  if is_our_panel "$p"; then
    printf '\n\033[32m✓ project-x is already running.\033[0m Opening http://localhost:%s\n\n' "$p"
    open "http://localhost:$p"
    exit 0
  fi
done
[ -n "$PORT" ] || die "Ports ${BASE_PORT}-$((BASE_PORT + PORT_TRIES - 1)) are all in use by something else."

# --- First run: install the web app's dependencies ---
if [ ! -d "$ROOT/web/node_modules" ]; then
  printf '\n\033[36mFirst run — installing the panel (a minute or so)…\033[0m\n\n'
  (cd "$ROOT/web" && npm ci) || die "npm ci failed in web/. Scroll up for the reason."
fi

printf '\n\033[1m  project-x\033[0m\n'
printf '  ─────────────────────────────────────────────\n'
printf '  Panel   http://localhost:%s\n' "$PORT"
printf '  Data    %s\n' "$ROOT"
printf '  Node    %s\n' "$("$NODE_BIN" -v)"
printf '  Mode    %s\n' "$MODE"
printf '  ─────────────────────────────────────────────\n'
printf '  Close this window or press Ctrl-C to stop.\n\n'

# --- Open the browser once the server actually answers ---
(
  for _ in $(seq 1 120); do
    if curl -sf --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/api/version"; then
      open "http://localhost:$PORT"
      exit 0
    fi
    sleep 0.5
  done
  printf '\n\033[33m! The panel did not answer within 60s — open http://localhost:%s by hand.\033[0m\n' "$PORT"
) &
OPENER_PID=$!

cd "$ROOT/web" || die "Could not enter $ROOT/web"
if [ "$MODE" = "rebuild" ] || { [ "$MODE" != "dev" ] && [ ! -d "$ROOT/web/.next" ]; }; then
  printf '\n\033[36mCompiling the panel (one-off, a few minutes)...\033[0m\n\n'
  # Cap the heap: an unbounded Next build is what the OOM killer reaches for first.
  NODE_OPTIONS="--max-old-space-size=2048" npm run build || die "build failed. Scroll up for the reason."
fi

if [ "$MODE" = "dev" ]; then
  npm run dev -- -p "$PORT" &
else
  npm start -- -p "$PORT" &
fi
DEV_PID=$!

cleanup() {
  trap - EXIT INT TERM HUP
  kill "$OPENER_PID" 2>/dev/null
  kill -TERM "-$DEV_PID" 2>/dev/null || kill -TERM "$DEV_PID" 2>/dev/null
  wait "$DEV_PID" 2>/dev/null
  printf '\n\033[36mproject-x stopped.\033[0m\n'
}
trap cleanup EXIT INT TERM HUP

wait "$DEV_PID"
