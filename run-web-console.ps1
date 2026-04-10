$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

python -m pip install -r ".\web_console\requirements.txt"
python -m uvicorn web_console.app:app --host 0.0.0.0 --port 15678 --app-dir "$root"
