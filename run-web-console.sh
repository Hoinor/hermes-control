#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  if command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  else
    echo "[ERR] Python is required."
    exit 1
  fi
else
  PYTHON_BIN="python3"
fi

"$PYTHON_BIN" -m pip install -r "$ROOT_DIR/web_console/requirements.txt"
exec "$PYTHON_BIN" -m uvicorn web_console.app:app --host 0.0.0.0 --port 15678 --app-dir "$ROOT_DIR"
