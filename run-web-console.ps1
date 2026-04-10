$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$venvDir = Join-Path $root ".web-console-venv"
$venvPy = Join-Path $venvDir "Scripts\\python.exe"
$frontendDir = Join-Path $root "web_console\\frontend"
$frontendLock = Join-Path $frontendDir "package-lock.json"
$installedFrontendLock = Join-Path $frontendDir "node_modules\\.package-lock.json"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw "Python is required."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "Node.js and npm are required to build the React frontend."
}

if (-not (Test-Path $venvPy)) {
  python -m venv $venvDir
}

& $venvPy -m pip install -r ".\web_console\backend\requirements.txt"

Push-Location $frontendDir
try {
  $needsFrontendInstall = (-not (Test-Path ".\\node_modules")) -or (-not (Test-Path $installedFrontendLock))
  if (-not $needsFrontendInstall) {
    $needsFrontendInstall =
      (Get-Item $frontendLock).LastWriteTimeUtc -gt (Get-Item $installedFrontendLock).LastWriteTimeUtc
  }

  if ($needsFrontendInstall) {
    & npm ci
  }
  & npm run build
}
finally {
  Pop-Location
}

& $venvPy -m uvicorn web_console.backend.app:app --host 0.0.0.0 --port 15678 --app-dir "$root"
