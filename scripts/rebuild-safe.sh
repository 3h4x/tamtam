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
WALL_CLOCK_TIMEOUT_S="${TAMTAM_REBUILD_WALL_CLOCK_TIMEOUT:-1800}"
FORCE="${TAMTAM_REBUILD_FORCE:-0}"
POLL_INTERVAL_S=5
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[rebuild-safe] %s\n' "$*"; }

# Hard wall-clock kill switch — if anything in this script hangs (drain
# polling against a crash-looping server, pnpm build that never returns,
# pm2-start blocked on a port), self-SIGTERM after 30min. The EXIT trap
# below still runs, which unpauses jobs. A hung rebuild that leaves jobs
# paused indefinitely (the iter #46 incident) is worse than just bailing.
WALL_CLOCK_PID=$$
( sleep "$WALL_CLOCK_TIMEOUT_S" && kill -TERM "$WALL_CLOCK_PID" 2>/dev/null ) >/dev/null 2>&1 &
WALL_CLOCK_WATCHDOG=$!
disown "$WALL_CLOCK_WATCHDOG" 2>/dev/null || true
cleanup_watchdog() {
  if [ -n "${WALL_CLOCK_WATCHDOG:-}" ]; then
    kill "$WALL_CLOCK_WATCHDOG" 2>/dev/null || true
  fi
}

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
# contextMeta; killing it mid-poll is recoverable.
#
# Filter contract: `/api/jobs?status=running` is the documented filter
# (route reads `searchParams.get('status')`). The legacy `?running=1`
# query was a no-op — the route ignored it and returned every job,
# making the drain check always see "0 blocking" and the rebuild kill
# active work. We also page the response to keep the payload small.
#
# Fail closed: on any curl/python error, return a non-zero sentinel so
# the drain loop keeps waiting (vs. the old behavior that treated API
# failure as "0 running" and proceeded to restart immediately).
count_blocking_jobs() {
  local offset=0
  local total=0
  while :; do
    local body
    if ! body=$(curl -sf "$BASE_URL/api/jobs?status=running&limit=200&offset=$offset" 2>/dev/null); then
      # API unreachable / non-200 — treat as still draining.
      echo 1
      return
    fi
    local parsed
    parsed=$(printf '%s' "$body" | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  is_list = isinstance(d, list)
  rows = d if is_list else d.get('jobs', d.get('rows', []))
  blocking_kinds = {'test','review','fix','commit','push','mark-dod','run','fix-ci'}
  n = 0
  for r in rows:
    if r.get('finished_at') is not None: continue
    k = r.get('kind', '')
    if k in blocking_kinds or k.startswith('agent:'):
      n += 1
  next_offset = None if is_list else d.get('nextOffset')
  print(f'{n}\\t{next_offset if next_offset is not None else \"\"}')
except Exception:
  # JSON parse / structure error — fail closed: report 1 so the
  # drain loop keeps polling instead of restarting blind.
  print('1')
")
    if [ "$parsed" = "1" ]; then
      echo 1
      return
    fi
    local page_count="${parsed%%	*}"
    local next_offset="${parsed#*	}"
    total=$((total + page_count))
    if [ -z "$next_offset" ] || [ "$next_offset" = "$parsed" ]; then
      echo "$total"
      return
    fi
    offset="$next_offset"
  done
}

PAUSED=0
trap '
  cleanup_watchdog
  if [ "$PAUSED" = 1 ] && [ "${KEEP_PAUSED:-0}" != 1 ]; then
    unpause_jobs >/dev/null 2>&1 || true
    printf "[rebuild-safe] unpaused jobs in exit trap\n"
  fi
' EXIT
# Also unpause on SIGTERM (wall-clock watchdog kill). The EXIT trap fires
# on SIGTERM by default, but make it explicit so the unpause path is
# obvious.
trap 'printf "[rebuild-safe] WALL CLOCK timeout (%ss) — bailing\n" "$WALL_CLOCK_TIMEOUT_S"; exit 124' TERM

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

# Smoke-probe critical pages. A pnpm build that raced with a fix-step
# writing into `app/` produces a `.next/` with missing client-reference
# manifests; the API stays healthy but server-rendered pages 500 with
# "Invariant: The client reference manifest for route ... does not exist".
# Auto-recover with a clean rebuild instead of leaving the user staring at
# `Internal Server Error`.
SMOKE_PAGES=("/" "/runs" "/agents" "/settings/general")
smoke_test() {
  local failures=0
  for path in "${SMOKE_PAGES[@]}"; do
    local code
    code=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE_URL$path" 2>/dev/null || echo "000")
    if [ "$code" != "200" ] && [ "$code" != "307" ] && [ "$code" != "308" ]; then
      log "smoke: $path → $code"
      failures=$((failures + 1))
    fi
  done
  return $failures
}

if ! smoke_test; then
  log "WARN: smoke test failed after restart — likely a manifest race from in-flight writes"
  log "auto-recovering with a clean .next/ rebuild..."
  rm -rf "$PWD/.next"
  if pnpm build && bash "$SCRIPT_DIR/pm2-start.sh"; then
    for _ in $(seq 1 30); do
      if curl -sf "$BASE_URL/api/settings" >/dev/null 2>&1; then break; fi
      sleep 1
    done
    if ! smoke_test; then
      log "ERROR: smoke still failing after clean rebuild — leaving jobs PAUSED for investigation"
      KEEP_PAUSED=1
      exit 3
    fi
    log "auto-recovery succeeded"
  else
    log "ERROR: clean rebuild failed — leaving jobs PAUSED for investigation"
    KEEP_PAUSED=1
    exit 3
  fi
fi

if [ "$PAUSED" = 1 ]; then
  log "unpausing jobs..."
  if ! unpause_jobs; then
    log "WARN: unpause failed — set jobs_paused=false manually via /settings"
  fi
fi

log "done"
