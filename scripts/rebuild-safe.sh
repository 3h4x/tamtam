#!/usr/bin/env bash
# Graceful rebuild: pause new work, wait for in-flight jobs to drain,
# build, restart, unpause.
#
# Drop-in replacement for the legacy `pnpm build && pnpm start` rebuild,
# which kills any in-flight pipeline/agent/run job mid-execution by
# dropping the spawned children on PM2 restart.
#
# Env knobs:
#   TAMTAM_BASE_URL              default http://localhost:1337
#   TAMTAM_REBUILD_DRAIN_TIMEOUT default 600 (seconds) — proceed anyway
#                                if jobs haven't drained in this long
#   TAMTAM_REBUILD_FORCE         set to 1 to skip pause+drain (legacy
#                                behavior) — useful when the server is
#                                already dead and you just need to bring
#                                it up.
#
# Exit codes:
#   0   built + restarted + unpaused
#   2   build failed (server NOT restarted; pause is reverted)
#   3   restart failed (pause is left ON intentionally so the server
#       doesn't pick up the new code half-restarted)

set -euo pipefail

BASE_URL="${TAMTAM_BASE_URL:-http://localhost:1337}"
DRAIN_TIMEOUT_S="${TAMTAM_REBUILD_DRAIN_TIMEOUT:-600}"
FORCE="${TAMTAM_REBUILD_FORCE:-0}"
POLL_INTERVAL_S=5
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[rebuild-safe] %s\n' "$*"; }

pause_jobs() {
  curl -sf -X PATCH "$BASE_URL/api/settings" \
    -H 'content-type: application/json' \
    -d '{"jobs_paused":true}' >/dev/null
}

unpause_jobs() {
  curl -sf -X PATCH "$BASE_URL/api/settings" \
    -H 'content-type: application/json' \
    -d '{"jobs_paused":false}' >/dev/null
}

# Count in-flight jobs whose mid-flight termination would lose work.
# pr-wait is excluded because the runtime resumes it on boot from
# contextMeta; killing it mid-poll is recoverable. Also filter on
# `status='running'` AND `finished_at IS NULL` — `/api/jobs?running=1`
# currently leaks finished rows whose probe sweep hasn't reconciled
# the running list yet.
count_blocking_jobs() {
  curl -sf "$BASE_URL/api/jobs?running=1" 2>/dev/null \
    | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  rows = d if isinstance(d, list) else d.get('jobs', d.get('rows', []))
  blocking_kinds = {'test','review','fix','commit','push','mark-dod','run','fix-ci'}
  n = 0
  for r in rows:
    if r.get('status') != 'running': continue
    if r.get('finished_at') is not None: continue
    k = r.get('kind', '')
    if k in blocking_kinds or k.startswith('agent:'):
      n += 1
  print(n)
except Exception:
  print(0)
" 2>/dev/null || echo 0
}

PAUSED=0
trap 'if [ "$PAUSED" = 1 ] && [ "${KEEP_PAUSED:-0}" != 1 ]; then unpause_jobs >/dev/null 2>&1 || true; fi' EXIT

if [ "$FORCE" = 1 ]; then
  log "force mode: skipping pause/drain"
else
  log "pausing jobs via PATCH /api/settings..."
  if pause_jobs 2>/dev/null; then
    PAUSED=1
  else
    log "API unreachable — server may already be down; continuing"
  fi

  if [ "$PAUSED" = 1 ]; then
    log "waiting up to ${DRAIN_TIMEOUT_S}s for active work to drain..."
    start=$(date +%s)
    while :; do
      running=$(count_blocking_jobs)
      if [ "${running:-0}" -eq 0 ]; then
        log "drained"
        break
      fi
      elapsed=$(( $(date +%s) - start ))
      if [ "$elapsed" -ge "$DRAIN_TIMEOUT_S" ]; then
        log "WARN: drain timeout — ${running} job(s) still running; proceeding (they will be killed)"
        break
      fi
      log "${running} job(s) still running (${elapsed}s elapsed)..."
      sleep "$POLL_INTERVAL_S"
    done
  fi
fi

log "building..."
if ! pnpm build; then
  log "build failed — leaving server running, jobs will be unpaused on exit"
  exit 2
fi

log "restarting via pm2..."
if ! bash "$SCRIPT_DIR/pm2-start.sh"; then
  log "ERROR: pm2 restart failed — leaving jobs PAUSED so half-restarted server doesn't pick up work"
  KEEP_PAUSED=1
  exit 3
fi

log "waiting for server to accept requests..."
for _ in $(seq 1 30); do
  if curl -sf "$BASE_URL/api/settings" >/dev/null 2>&1; then break; fi
  sleep 1
done

if [ "$PAUSED" = 1 ]; then
  log "unpausing jobs..."
  if ! unpause_jobs; then
    log "WARN: unpause failed — set jobs_paused=false manually via /settings"
  fi
fi

log "done"
