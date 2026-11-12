#!/bin/bash
# panel-serve.sh — serve the career-ops web panel, for launchd.
#
# Unlike CareerOps.command this opens no browser and prints no banner: it is a
# service entry point, not something you double-click. Serves the PRODUCTION
# build (~120 MB steady, precompiled pages), never `next dev`.
#
# Managed by ~/Library/LaunchAgents/io.career-ops.panel.plist:
#   launchctl kickstart -k gui/$(id -u)/io.career-ops.panel   # restart
#   launchctl bootout    gui/$(id -u)/io.career-ops.panel     # stop
#
# Local to this checkout; not upstream. Safe from `npm run update`.

set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${CAREER_OPS_PORT:-3000}"

# launchd gives a near-empty environment: no ~/.zshrc, no nvm shims. Resolve the
# interpreter explicitly or the service fails at every login, silently.
pick_node() {
  local c maj
  local -a cands=()
  command -v node >/dev/null 2>&1 && cands+=("$(command -v node)")
  while IFS= read -r c; do cands+=("$c"); done < <(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -r)
  cands+=(/opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node)
  for c in "${cands[@]}"; do
    [ -x "$c" ] || continue
    maj="$("$c" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
    [ -n "$maj" ] && [ "$maj" -ge 22 ] 2>/dev/null && { printf '%s' "$c"; return 0; }
  done
  return 1
}

NODE_BIN="$(pick_node)" || { echo "FATAL: no node >= 22 found" >&2; exit 1; }
export PATH="$(dirname "$NODE_BIN"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export CAREER_OPS_ROOT="$ROOT"

cd "$ROOT/web" || { echo "FATAL: no $ROOT/web" >&2; exit 1; }

# No build here on purpose. A build under memory pressure is what gets killed,
# and KeepAlive would then retry it in a loop. Build deliberately instead:
#   ./CareerOps.command rebuild
if [ ! -d "$ROOT/web/.next" ]; then
  echo "FATAL: no production build. Run: ./CareerOps.command rebuild" >&2
  exit 1
fi

echo "career-ops panel starting on http://localhost:$PORT (data: $ROOT)"
exec npm start -- -p "$PORT"
