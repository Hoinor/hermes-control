$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$venvDir = Join-Path $root ".web-console-venv"
$venvPy = Join-Path $venvDir "Scripts\\python.exe"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw "Python is required."
}

if (-not (Test-Path $venvPy)) {
  python -m venv $venvDir
}

& $venvPy -m pip install -r ".\web_console\backend\requirements.txt"
& $venvPy -m uvicorn web_console.backend.app:app --host 0.0.0.0 --port 15678 --app-dir "$root"
