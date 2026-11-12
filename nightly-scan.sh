#!/bin/bash
# nightly-scan.sh — unattended full-network sweep for career-ops.
#
#   ./nightly-scan.sh fast      greenhouse + lever + ashby   (~6 min, 15,862 companies)
#   ./nightly-scan.sh workday   workday only                 (15+ min, rate-limited)
#   ./nightly-scan.sh fast --seed   populate history WITHOUT flooding the pipeline
#
# Freshness comes from data/scan-history.tsv, not from the date window: every URL
# ever surfaced is recorded with first_seen and skipped forever after, so whatever
# lands in data/pipeline.md is by definition new since last night. That survives a
# missed night and does not depend on postings carrying a usable date.
#
# Deliberately NOT --dry-run: a real run is what writes scan-history, learns dead
# boards (43% of listed boards are defunct, and it skips them next time), and
# checkpoints so --resume can continue after an interruption.
#
# Local to this checkout; not upstream. Safe from `npm run update`.

set -uo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${1:-fast}"
SEED_MODE=0
[ "${2:-}" = "--seed" ] && SEED_MODE=1

LOG_DIR="$HOME/Library/Logs/career-ops"
LOCK="$ROOT/data/.nightly-scan.lock"
SINCE_DAYS=30          # wide on purpose — scan-history decides what is NEW, not this
mkdir -p "$LOG_DIR"

case "$PROFILE" in
  fast)    ATS="greenhouse,lever,ashby" ;;
  workday) ATS="workday" ;;
  *) echo "unknown profile '$PROFILE' (want: fast | workday)" >&2; exit 2 ;;
esac

LOG="$LOG_DIR/$PROFILE.log"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }

# --- single instance ------------------------------------------------------
# launchd will happily start a second copy if the first overran its interval;
# two writers on pipeline.md/scan-history.tsv is how those files get mangled.
exec 9>"$LOCK"
if ! flock -n 9 2>/dev/null; then
  # macOS bash has no flock; fall back to a pid file check.
  if [ -s "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
    log "SKIP: $PROFILE already running (pid $(cat "$LOCK"))"
    exit 0
  fi
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# --- resolve node ---------------------------------------------------------
# launchd gives an even barer environment than a double-clicked .command:
# no ~/.zshrc, no nvm shims. Resolve the interpreter explicitly or the job
# fails nightly, silently, forever.
pick_node() {
  local c maj
  local -a cands=()
  command -v node >/dev/null 2>&1 && cands+=("$(command -v node)")
  while IFS= read -r c; do cands+=("$c"); done < <(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -r)
  cands+=(/opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node)
  for c in "${cands[@]}"; do
    [ -x "$c" ] || continue
    maj="$("$c" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
    [ -n "$maj" ] && [ "$maj" -ge 20 ] 2>/dev/null && { printf '%s' "$c"; return 0; }
  done
  return 1
}
NODE_BIN="$(pick_node)" || { log "FATAL: no node >= 20 found"; exit 1; }
export PATH="$(dirname "$NODE_BIN"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# --- rotate (keep it small; this runs every day) --------------------------
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" | tr -d ' ')" -gt 5000000 ]; then
  mv "$LOG" "$LOG.1"
fi

# --- seeding mode ---------------------------------------------------------
# First ever run: history is empty, so EVERY current posting is "new" and would
# land in the pipeline at once. Seed instead — run normally, then restore
# pipeline.md, keeping the scan-history rows. Tomorrow's run is then a true diff.
PIPELINE="$ROOT/data/pipeline.md"
if [ "$SEED_MODE" = "1" ]; then
  cp "$PIPELINE" "$PIPELINE.preseed" 2>/dev/null
  log "SEED MODE: pipeline.md will be restored after the sweep"
fi

log "START $PROFILE — ats=$ATS since=${SINCE_DAYS}d (full depth, no --limit)"
START=$(date +%s)

"$NODE_BIN" "$ROOT/scan-ats-full.mjs" \
  --ats "$ATS" \
  --since "$SINCE_DAYS" \
  --include-undated \
  >> "$LOG" 2>&1
RC=$?

ELAPSED=$(( $(date +%s) - START ))

if [ "$SEED_MODE" = "1" ] && [ -f "$PIPELINE.preseed" ]; then
  mv "$PIPELINE.preseed" "$PIPELINE"
  log "SEED MODE: pipeline.md restored — scan-history keeps the baseline"
fi

HIST=0
[ -f "$ROOT/data/scan-history.tsv" ] && HIST=$(( $(wc -l < "$ROOT/data/scan-history.tsv") - 1 ))
log "END   $PROFILE rc=$RC in ${ELAPSED}s — scan-history now holds $HIST rows"
exit "$RC"
