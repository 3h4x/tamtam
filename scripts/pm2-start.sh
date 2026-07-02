#!/usr/bin/env bash
# Idempotent, orphan-safe start for the TamTam Next.js server under PM2.
#
# Why this script exists:
#   `pm2 start 'next start ...' --name tamtam` makes PM2 spawn a `bash -c`
#   wrapper. PM2 tracks the bash PID — not the next-server child. On
#   stop/delete/restart, PM2 signals bash; bash exits; the grandchild
#   next-server survives as an orphan that PM2 no longer knows exists.
#   That orphan keeps holding port 1337 and serves stale code.
#
# What this does:
#   1. If PM2 already has a `tamtam` entry whose registered script is the
#      `next` binary directly (no bash wrapper), restart in place.
#   2. Otherwise: delete any stale `tamtam` entries, reclaim port 1337
#      from any non-PM2-tracked squatter (the orphan case), then register
#      a fresh entry that has PM2 spawn `next` directly via `--interpreter
#      node` so signals propagate cleanly and no orphan can survive.

set -euo pipefail

PORT="${PORT:-1337}"
HOST="${HOST:-127.0.0.1}"
NAME="tamtam"
NEXT_BIN="$PWD/node_modules/next/dist/bin/next"

# Pin workflow runtime data dir BEFORE PM2 starts the process. `next.config.ts`
# sets these too, but that only takes effect inside the Node process — PM2's
# saved env snapshot is the one the workflow runtime sees on its first read,
# and a stale `.next/workflow-data` value from a legacy launch was orphaning
# every release that ran across a rebuild (the build wipes `.next/`).
# Setting them here makes PM2 record the durable value in its snapshot so
# `--update-env` refreshes do the right thing too.
export WORKFLOW_TARGET_WORLD="${WORKFLOW_TARGET_WORLD:-local}"
if [ "$WORKFLOW_TARGET_WORLD" = "local" ]; then
  export WORKFLOW_LOCAL_DATA_DIR="${WORKFLOW_LOCAL_DATA_DIR:-data/workflow-data}"
fi

# Guarantee HOME/USER in PM2's env snapshot. The PM2 daemon may have been
# launched from a context with a stripped env, and `pm2 start`/`--update-env`
# fork the app from *that* env — so without pinning here the server runs with
# no HOME. That silently breaks every git/gh call that resolves config from ~:
# global `.gitignore` (core.excludesFile), commit identity, and gh auth/hosts.
# The visible symptom was the PR-branch execution gate refusing a clean tree
# ("uncommitted or untracked changes") because globally-ignored files
# (.playwright-mcp/, .DS_Store) showed as untracked when git couldn't read the
# global excludesfile. Derive HOME from the passwd db when the env lacks it.
if [ -z "${HOME:-}" ]; then
  export HOME="$(eval echo "~$(id -un)")"
fi
export USER="${USER:-$(id -un)}"

if [ ! -x "$NEXT_BIN" ] && [ ! -f "$NEXT_BIN" ]; then
  echo "[pm2-start] next binary not found at $NEXT_BIN — run pnpm install first" >&2
  exit 1
fi

# Ensure the Postgres container from docker-compose.yml is up before PM2
# starts the Next.js server. Without this, the server boots, hits
# ECONNREFUSED on every query, and floods logs until someone notices.
if [ -f "docker-compose.yml" ]; then
  if ! docker info >/dev/null 2>&1; then
    echo "[pm2-start] Docker daemon is not running — start Docker Desktop and retry" >&2
    exit 1
  fi
  echo "[pm2-start] ensuring docker compose services are up"
  docker compose up -d --wait
fi

start_fresh() {
  # Wipe any stale `tamtam` entries (legacy bash-wrapped, errored, etc.).
  pm2 delete "$NAME" >/dev/null 2>&1 || true

  # If something still holds port 1337 after PM2 cleanup, it's an orphan
  # PM2 lost track of. Kill *only* that PID — never blanket-kill.
  SQUATTER="$(lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$SQUATTER" ]; then
    echo "[pm2-start] reclaiming port $PORT from orphan PID(s): $SQUATTER"
    kill $SQUATTER 2>/dev/null || true
    sleep 1
    SQUATTER="$(lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$SQUATTER" ]; then
      echo "[pm2-start] orphan refused SIGTERM; sending SIGKILL to $SQUATTER"
      kill -9 $SQUATTER 2>/dev/null || true
      sleep 1
    fi
  fi

  # --interpreter node makes PM2 spawn `node next start ...` directly.
  # No bash wrapper => PM2 tracks the actual server PID => clean lifecycle.
  pm2 start "$NEXT_BIN" \
    --name "$NAME" \
    --cwd . \
    --time \
    --interpreter node \
    -- start --port "$PORT" --hostname "$HOST"
}

# Already running cleanly? Restart in place.
if pm2 describe "$NAME" >/dev/null 2>&1; then
  EXEC_PATH="$(pm2 jlist 2>/dev/null \
    | python3 -c "import sys,json
d=json.load(sys.stdin)
for p in d:
  if p.get('name')=='$NAME':
    print(p.get('pm2_env',{}).get('pm_exec_path',''))
    break" 2>/dev/null || echo "")"
  case "$EXEC_PATH" in
    */next/dist/bin/next|*/node_modules/.bin/next)
      echo "[pm2-start] restarting existing tamtam entry (clean spawn)"
      exec pm2 restart "$NAME" --update-env
      ;;
    *)
      echo "[pm2-start] existing tamtam entry uses legacy spawn ($EXEC_PATH); re-registering"
      start_fresh
      ;;
  esac
else
  start_fresh
fi
