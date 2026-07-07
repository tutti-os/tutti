#!/usr/bin/env bash
set -euo pipefail
if [ -z "${TUTTI_APP_PORT:-}" ]; then
  echo "TUTTI_APP_PORT is required" >&2
  exit 64
fi
HOST="${TUTTI_APP_HOST:-127.0.0.1}"
NODE="${TUTTI_APP_NODE:-}"
if [ -z "$NODE" ]; then
  echo "TUTTI_APP_NODE is required" >&2
  exit 64
fi
cd "${TUTTI_APP_PACKAGE_DIR:-$(cd "$(dirname "$0")" && pwd)}"
exec "$NODE" server.js
