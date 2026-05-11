#!/usr/bin/env bash
# Ensure the QA docker-compose stack is up and reachable on localhost:1338.
# Idempotent: if the container is already healthy, exits 0 immediately.
# Otherwise starts it in detached mode and waits up to ~60s for readiness.
set -euo pipefail

URL="http://localhost:1338/"
SERVICE="tamtam-qa"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.qa.yml"

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

service_running() {
  compose ps --status running --services 2>/dev/null | grep -Fxq "$SERVICE"
}

http_ready() {
  curl -fsS -o /dev/null --max-time 2 "$URL"
}

stack_ready() {
  service_running && http_ready
}

if stack_ready; then
  echo "QA stack already running at $URL"
  exit 0
fi

echo "QA stack not reachable — starting docker compose…"
compose up -d --build

for i in $(seq 1 30); do
  if stack_ready; then
    echo "QA stack ready at $URL (after ${i}x2s)"
    exit 0
  fi
  sleep 2
done

echo "QA stack failed to become ready at $URL within 60s" >&2
compose ps >&2 || true
exit 1
