#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_TMP_DIR="$ROOT_DIR/local-tmp"
PERSIST_DIR="$LOCAL_TMP_DIR/wrangler-state"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$LOCAL_TMP_DIR/xdg-config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$LOCAL_TMP_DIR/xdg-cache}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$LOCAL_TMP_DIR/xdg-data}"
NPM_CACHE_DIR="${npm_config_cache:-$LOCAL_TMP_DIR/npm-cache}"
LOCAL_WRANGLER_BIN="$ROOT_DIR/node_modules/.bin/wrangler"
PORT="${PORT:-8787}"

export XDG_CONFIG_HOME
export XDG_CACHE_HOME
export XDG_DATA_HOME
export npm_config_cache="$NPM_CACHE_DIR"
export WRANGLER_SEND_METRICS="${WRANGLER_SEND_METRICS:-false}"
export WRANGLER_SEND_ERROR_REPORTS="${WRANGLER_SEND_ERROR_REPORTS:-false}"

mkdir -p \
  "$PERSIST_DIR" \
  "$XDG_CONFIG_HOME/.wrangler/logs" \
  "$XDG_CONFIG_HOME/.wrangler/registry" \
  "$XDG_CACHE_HOME" \
  "$XDG_DATA_HOME" \
  "$NPM_CACHE_DIR"

run_wrangler() {
  if [[ -x "$LOCAL_WRANGLER_BIN" ]]; then
    "$LOCAL_WRANGLER_BIN" "$@"
  else
    npx --yes wrangler "$@"
  fi
}

if [[ -f "$ROOT_DIR/.env" ]]; then
  echo "[local-dev] loading runtime vars from .env"
  set -a
  . "$ROOT_DIR/.env"
  set +a
elif [[ ! -f "$ROOT_DIR/.dev.vars" ]]; then
  echo "[local-dev] warning: neither .env nor .dev.vars found, wrangler may miss runtime vars."
fi

cd "$ROOT_DIR"

echo "[local-dev] initializing local D1 schema..."
run_wrangler d1 execute DB \
  --local \
  --persist-to "$PERSIST_DIR" \
  --file migrations/0001_initial_schema.sql

echo "[local-dev] starting worker at http://127.0.0.1:${PORT}"
if [[ -x "$LOCAL_WRANGLER_BIN" ]]; then
  exec "$LOCAL_WRANGLER_BIN" dev \
    --local \
    --persist-to "$PERSIST_DIR" \
    --port "$PORT"
else
  exec npx --yes wrangler dev \
    --local \
    --persist-to "$PERSIST_DIR" \
    --port "$PORT"
fi
