#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$ROOT_DIR/.web-console-venv"
FRONTEND_DIR="$ROOT_DIR/web_console/frontend"
FRONTEND_LOCK="$FRONTEND_DIR/package-lock.json"
INSTALLED_FRONTEND_LOCK="$FRONTEND_DIR/node_modules/.package-lock.json"

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

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERR] Node.js and npm are required to build the React frontend."
  exit 1
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

pushd "$FRONTEND_DIR" >/dev/null
if [[ ! -d "$FRONTEND_DIR/node_modules" || ! -f "$INSTALLED_FRONTEND_LOCK" || "$FRONTEND_LOCK" -nt "$INSTALLED_FRONTEND_LOCK" ]]; then
  npm ci
fi
npm run build
popd >/dev/null

exec "$VENV_PY" -m uvicorn web_console.backend.app:app --host 0.0.0.0 --port 15678 --app-dir "$ROOT_DIR"
