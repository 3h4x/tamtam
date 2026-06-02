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
# The server (PM2 `tamtam`) is STOPPED before the build and brought back by
# pm2-start.sh after a successful build + migrate. This trades brief build-time
# downtime for safety: a build that overwrites `.next/` while `next start` is
# live can leave the server crash-looping on a half-written build.
#
# A cross-process mutex (atomic `mkdir` lock in TMPDIR) serializes rebuilds so a
# manual rebuild and a scheduled self-agent rebuild can never build at once.
#
# Env knobs (lock):
#   TAMTAM_REBUILD_LOCK_WAIT  default 900 (seconds) — how long to wait for a
#                             concurrent rebuild before giving up (exit 4)
#
# Exit codes:
#   0   built + restarted + unpaused
#   2   build or migrate failed (server left STOPPED, jobs left paused; fix
#       and re-run rebuild — a successful run restarts + unpauses)
#   3   restart failed (pause is left ON intentionally so the server
#       doesn't pick up the new code half-restarted)
#   4   could not acquire the build lock within TAMTAM_REBUILD_LOCK_WAIT
#       (another rebuild is running; no side effects — nothing paused/stopped)

set -euo pipefail

BASE_URL="${TAMTAM_BASE_URL:-http://localhost:1337}"
DRAIN_TIMEOUT_S="${TAMTAM_REBUILD_DRAIN_TIMEOUT:-600}"
WALL_CLOCK_TIMEOUT_S="${TAMTAM_REBUILD_WALL_CLOCK_TIMEOUT:-1800}"
FORCE="${TAMTAM_REBUILD_FORCE:-0}"
POLL_INTERVAL_S=5
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Cross-process build mutex. Two rebuilds (e.g. a manual one + a scheduled
# self-agent that edits UI and runs `pnpm run rebuild`) must never build at
# once: they fight over `.next/lock`, and each one's `pm2 stop tamtam` yanks
# the server out from under the other. macOS has no util-linux `flock`, so we
# use an atomic `mkdir` lock keyed on the repo path. Kept in TMPDIR (not under
# `.next/`, which the smoke-recovery path wipes; not in the repo, which would
# dirty the git tree agents inspect).
__repo_hash="$(printf '%s' "$PWD" | shasum 2>/dev/null | cut -c1-12 || true)"
LOCK_DIR="${TMPDIR:-/tmp}/tamtam-rebuild-${__repo_hash:-default}.lock"
LOCK_WAIT_S="${TAMTAM_REBUILD_LOCK_WAIT:-900}"
LOCK_HELD=0

log() { printf '[rebuild-safe] %s\n' "$*"; }

# Acquire the build mutex. Blocks (polling) until the current holder finishes
# or `LOCK_WAIT_S` elapses. A second concurrent rebuild waits rather than
# racing; if it waits out the timeout it exits WITHOUT building or touching
# pause/server state (the holder's build already covers the current code).
# Stale locks from a crashed rebuild are reclaimed via the recorded PID.
acquire_lock() {
  local start; start=$(date +%s)
  mkdir -p "$(dirname "$LOCK_DIR")" 2>/dev/null || true
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    local holder=""
    [ -f "$LOCK_DIR/pid" ] && holder=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      log "reclaiming stale rebuild lock from dead PID $holder"
      rm -rf "$LOCK_DIR"
      continue
    fi
    local elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$LOCK_WAIT_S" ]; then
      log "another rebuild has held the lock for ${LOCK_WAIT_S}s — giving up without building (its build covers current code)"
      exit 4
    fi
    log "another rebuild in progress (holder PID ${holder:-?}); waiting... (${elapsed}s)"
    sleep "$POLL_INTERVAL_S"
  done
  echo "$$" > "$LOCK_DIR/pid"
  LOCK_HELD=1
  log "acquired build lock"
}

release_lock() {
  if [ "${LOCK_HELD:-0}" = 1 ]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
    LOCK_HELD=0
  fi
}

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
  # Sets rebuild_in_progress alongside jobs_paused so the UI top-menu chip
  # shows "rebuilding…" instead of the ambiguous "jobs paused" while a
  # rebuild is in flight. Cleared by unpause_jobs and by the EXIT trap.
  curl -sf -X PATCH "$BASE_URL/api/settings" \
    -H 'content-type: application/json' \
    -d '{"jobs_paused":true,"rebuild_in_progress":true}' >/dev/null
}

unpause_jobs() {
  curl -sf -X PATCH "$BASE_URL/api/settings" \
    -H 'content-type: application/json' \
    -d '{"jobs_paused":false,"rebuild_in_progress":false}' >/dev/null
}

# Best-effort: clear just the rebuild flag without touching jobs_paused.
# Used on KEEP_PAUSED exits so the chip stops claiming "rebuilding" once
# the script gives up, but the manual pause state stays intact.
clear_rebuild_flag() {
  curl -sf -X PATCH "$BASE_URL/api/settings" \
    -H 'content-type: application/json' \
    -d '{"rebuild_in_progress":false}' >/dev/null 2>&1 || true
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
  release_lock
  if [ "$PAUSED" = 1 ] && [ "${KEEP_PAUSED:-0}" != 1 ]; then
    unpause_jobs >/dev/null 2>&1 || true
    printf "[rebuild-safe] unpaused jobs in exit trap\n"
  elif [ "$PAUSED" = 1 ]; then
    # KEEP_PAUSED path: leave jobs_paused on, but stop claiming a rebuild
    # is still in progress now that the script is bailing out.
    clear_rebuild_flag
    printf "[rebuild-safe] cleared rebuild flag (jobs left paused)\n"
  fi
' EXIT
# Also unpause on SIGTERM (wall-clock watchdog kill). The EXIT trap fires
# on SIGTERM by default, but make it explicit so the unpause path is
# obvious.
trap 'printf "[rebuild-safe] WALL CLOCK timeout (%ss) — bailing\n" "$WALL_CLOCK_TIMEOUT_S"; exit 124' TERM

# Serialize against any other rebuild BEFORE pausing/stopping anything. A
# waiter that times out here exits 4 with no side effects.
acquire_lock

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

# Stop the server BEFORE building. `pnpm build` overwrites `.next/` in place;
# if the live `next start` reloads (PM2 restart, crash, OOM) while the build is
# mid-write, it boots against a half-written `.next/` and crash-loops
# ("Could not find a production build in the '.next' directory" / missing
# manifests), which then starves the build of CPU/RAM and can get the build
# itself OOM-killed. Stopping PM2 first gives the build the machine to itself
# and guarantees no live server can pick up an in-progress `.next/`. The server
# is brought back by pm2-start.sh after a successful build + migrate.
SERVER_STOPPED=0
# Returns 0 if the pm2 `tamtam` entry is in the `online` state, 1 otherwise.
# A live `next start` during the build is the worst case: it both races the
# `.next/` overwrite (crash-loop risk) AND steals CPU from the build, which
# is the dominant driver of slow builds on this box (see build-with-metrics
# `load` block). So we must be sure it is actually down, not assume it.
server_is_online() {
  pm2 jlist 2>/dev/null | python3 -c "
import json, sys
try:
  procs = json.load(sys.stdin)
  for p in procs:
    if p.get('name') == 'tamtam':
      sys.exit(0 if p.get('pm2_env', {}).get('status') == 'online' else 1)
except Exception:
  pass
sys.exit(1)
" 2>/dev/null
}
stop_server() {
  if ! pm2 describe tamtam >/dev/null 2>&1; then
    log "no pm2 tamtam entry — nothing to stop"
    return
  fi
  log "stopping tamtam (pm2) before build..."
  pm2 stop tamtam >/dev/null 2>&1 || true
  # Verify it actually stopped. A swallowed `pm2 stop` failure that left the
  # server online used to be invisible — the build then ran against a live
  # server (contention + crash-loop risk). Retry with a delete, then refuse
  # to build if it is still up rather than proceeding blind.
  for attempt in 1 2; do
    if ! server_is_online; then
      SERVER_STOPPED=1
      return
    fi
    log "WARN: tamtam still online after stop (attempt ${attempt}) — escalating to pm2 delete"
    pm2 delete tamtam >/dev/null 2>&1 || true
    sleep 1
  done
  if server_is_online; then
    log "ERROR: could not stop tamtam (pm2) — refusing to build against a live server."
    log "       Stop it manually (\`pm2 stop tamtam\`) and re-run rebuild."
    KEEP_PAUSED=1
    exit 3
  fi
  SERVER_STOPPED=1
}
stop_server

log "building..."
if ! pnpm build; then
  # Server is already stopped, so a broken/partial `.next/` can't crash-loop.
  # Leave it stopped and jobs paused; fix the build and re-run rebuild (a
  # successful run restarts the server and unpauses at the end).
  log "build failed — server left STOPPED, jobs left paused. Fix the build and re-run rebuild."
  KEEP_PAUSED=1
  exit 2
fi

# Apply pending DB migrations BEFORE swapping in the new code. Skipping this
# (the previous behavior) silently dropped operator-tuned settings any time a
# migration renamed a key — the new server booted, read the missing key,
# defaulted it, and only the operator running `pnpm db:migrate` by hand would
# recover it. Treat migrate failures the same way as build failures: don't
# restart, exit non-zero so the EXIT trap unpauses jobs against the old code.
log "applying DB migrations..."
if ! pnpm db:migrate; then
  # Server is stopped at this point (we stop before build). Leave it stopped
  # and jobs paused rather than starting new code against an un-migrated DB.
  log "ERROR: db:migrate failed — server left STOPPED, jobs left paused. Fix the migration and re-run rebuild."
  KEEP_PAUSED=1
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
SMOKE_PAGES=("/" "/workflow-runs" "/agents" "/settings/general")
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
