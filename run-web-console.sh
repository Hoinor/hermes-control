#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$ROOT_DIR/.web-console-venv"

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

if [[ ! -x "$VENV_DIR/bin/python" && ! -x "$VENV_DIR/Scripts/python.exe" ]]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

if [[ -x "$VENV_DIR/bin/python" ]]; then
  VENV_PY="$VENV_DIR/bin/python"
elif [[ -x "$VENV_DIR/Scripts/python.exe" ]]; then
  VENV_PY="$VENV_DIR/Scripts/python.exe"
else
  echo "[ERR] Failed to initialize virtual environment."
  exit 1
fi

"$VENV_PY" -m pip install -r "$ROOT_DIR/web_console/backend/requirements.txt"
exec "$VENV_PY" -m uvicorn web_console.backend.app:app --host 0.0.0.0 --port 15678 --app-dir "$ROOT_DIR"
