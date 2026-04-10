from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import platform
import secrets
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import psutil
import yaml
from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field, field_validator

APP_DIR = Path(__file__).resolve().parent
WEB_CONSOLE_DIR = APP_DIR.parent
FRONTEND_DIST_DIR = WEB_CONSOLE_DIR / "frontend" / "dist"
FRONTEND_DIST_INDEX = FRONTEND_DIST_DIR / "index.html"
FRONTEND_ASSETS_DIR = FRONTEND_DIST_DIR / "assets"

HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
CONFIG_PATH = HERMES_HOME / "config.yaml"
AUTH_PATH = HERMES_HOME / "web-console-auth.json"
BACKUP_DIR = HERMES_HOME / "backups"
LOG_DIR = HERMES_HOME / "logs"
DEFAULT_PORT = 15678
SESSION_COOKIE_NAME = "hermes_console_session"
SESSION_TTL_SECONDS = 8 * 60 * 60

sessions: dict[str, float] = {}

app = FastAPI(title="Hermes Web Console", version="0.1.0")
app.mount("/static", StaticFiles(directory=str(WEB_CONSOLE_DIR / "static")), name="static")
app.mount("/assets", StaticFiles(directory=str(FRONTEND_ASSETS_DIR), check_dir=False), name="assets")
templates = Jinja2Templates(directory=str(WEB_CONSOLE_DIR / "templates"))


class PasswordPayload(BaseModel):
    password: str = Field(min_length=8, max_length=256)


class ServiceActionPayload(BaseModel):
    action: str


class ConfigSavePayload(BaseModel):
    config: dict[str, Any]


class RawConfigPayload(BaseModel):
    raw_yaml: str


class RestorePayload(BaseModel):
    backup_name: str

    @field_validator("backup_name")
    @classmethod
    def validate_backup_name(cls, value: str) -> str:
        if "/" in value or "\\" in value:
            raise ValueError("invalid backup name")
        return value


class ModelTarget(BaseModel):
    provider_key: str = ""
    model: str
    api_base_url: str
    api_key: str = ""


class ModelTestPayload(BaseModel):
    targets: list[ModelTarget] | None = None
    timeout_seconds: int = Field(default=20, ge=3, le=60)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatPayload(BaseModel):
    messages: list[ChatMessage]
    provider_key: str | None = None
    model: str | None = None
    temperature: float = Field(default=0.2, ge=0.0, le=2.0)
    max_tokens: int = Field(default=800, ge=16, le=4096)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def load_json_file(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        return None
    return data


def write_json_file(path: Path, data: dict[str, Any]) -> None:
    ensure_parent(path)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    temp_path.replace(path)


def password_hash(password: str, salt: bytes | None = None, iterations: int = 450_000) -> dict[str, Any]:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return {
        "salt": salt.hex(),
        "iterations": iterations,
        "hash": digest.hex(),
        "created_at": now_iso(),
    }


def verify_password(password: str, record: dict[str, Any]) -> bool:
    try:
        salt = bytes.fromhex(str(record["salt"]))
        iterations = int(record["iterations"])
        expected = bytes.fromhex(str(record["hash"]))
    except Exception:
        return False
    current = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(current, expected)


def auth_record_exists() -> bool:
    return AUTH_PATH.exists()


def get_auth_record() -> dict[str, Any]:
    record = load_json_file(AUTH_PATH)
    if not record:
        raise HTTPException(status_code=500, detail="auth record is corrupted")
    return record


def create_session() -> str:
    token = secrets.token_urlsafe(32)
    sessions[token] = time.time() + SESSION_TTL_SECONDS
    return token


def drop_session(token: str | None) -> None:
    if token and token in sessions:
        del sessions[token]


def is_session_valid(token: str | None) -> bool:
    if not token:
        return False
    expiry = sessions.get(token)
    if not expiry:
        return False
    if expiry < time.time():
        del sessions[token]
        return False
    return True


def require_auth(session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME)) -> str:
    if not auth_record_exists():
        raise HTTPException(status_code=428, detail="setup_required")
    if not is_session_valid(session_token):
        raise HTTPException(status_code=401, detail="unauthorized")
    return session_token or ""


def run_command(command: list[str], timeout: int = 40) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        duration_ms = int((time.perf_counter() - started) * 1000)
        return {
            "ok": result.returncode == 0,
            "code": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "command": command,
            "duration_ms": duration_ms,
        }
    except FileNotFoundError:
        return {
            "ok": False,
            "code": 127,
            "stdout": "",
            "stderr": f"command not found: {command[0]}",
            "command": command,
            "duration_ms": int((time.perf_counter() - started) * 1000),
        }
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "code": 124,
            "stdout": "",
            "stderr": "command timeout",
            "command": command,
            "duration_ms": int((time.perf_counter() - started) * 1000),
        }


def find_hermes_bin() -> str | None:
    which_result = shutil.which("hermes")
    if which_result:
        return which_result

    candidates = [
        Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "hermes",
        Path.home() / ".local" / "bin" / "hermes",
        Path.home() / ".hermes" / "hermes-agent" / "venv" / "Scripts" / "hermes.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def run_hermes(args: list[str], timeout: int = 120) -> dict[str, Any]:
    hermes_bin = find_hermes_bin()
    if not hermes_bin:
        return {
            "ok": False,
            "code": 127,
            "stdout": "",
            "stderr": "hermes command not found",
            "command": ["hermes", *args],
            "duration_ms": 0,
        }
    return run_command([hermes_bin, *args], timeout=timeout)


def read_config_text() -> str:
    if not CONFIG_PATH.exists():
        return ""
    return CONFIG_PATH.read_text(encoding="utf-8")


def read_config() -> dict[str, Any]:
    text = read_config_text()
    if not text.strip():
        return {}
    try:
        loaded = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise HTTPException(status_code=400, detail=f"invalid yaml: {exc}") from exc
    if loaded is None:
        return {}
    if not isinstance(loaded, dict):
        raise HTTPException(status_code=400, detail="config root must be a mapping")
    return loaded


def write_config(config: dict[str, Any]) -> None:
    ensure_parent(CONFIG_PATH)
    dumped = yaml.safe_dump(config, allow_unicode=True, sort_keys=False)
    temp_path = CONFIG_PATH.with_suffix(".yaml.tmp")
    temp_path.write_text(dumped, encoding="utf-8")
    temp_path.replace(CONFIG_PATH)


def normalize_api_base(api_base_url: str) -> str:
    base = api_base_url.strip().rstrip("/")
    if not base:
        return base
    if base.endswith("/v1"):
        return base
    return f"{base}/v1"


def service_runtime_status() -> dict[str, Any]:
    status = {
        "running": False,
        "source": "unknown",
        "detail": "",
    }
    if shutil.which("systemctl"):
        active = run_command(["systemctl", "--user", "is-active", "hermes-gateway"])
        if active["ok"] and active["stdout"] == "active":
            status["running"] = True
            status["source"] = "systemctl"
            status["detail"] = "active"
            return status
        status["source"] = "systemctl"
        status["detail"] = active["stdout"] or active["stderr"]

    if shutil.which("pgrep"):
        pgrep = run_command(["pgrep", "-f", "hermes.*gateway|hermes-gateway"])
        if pgrep["ok"]:
            status["running"] = True
            status["source"] = "pgrep"
            status["detail"] = "matched process"
            return status

    return status


def service_installed_status() -> bool:
    candidates = [
        Path.home() / ".config" / "systemd" / "user" / "hermes-gateway.service",
        HERMES_HOME / "hermes-gateway.service",
    ]
    return any(path.exists() for path in candidates)


def hermes_summary() -> dict[str, Any]:
    hermes_bin = find_hermes_bin()
    installed = bool(hermes_bin)
    version = ""
    if installed:
        version_res = run_hermes(["--version"], timeout=20)
        if version_res["ok"]:
            version = (version_res["stdout"] or "").splitlines()[0] if version_res["stdout"] else ""
    return {
        "installed": installed,
        "bin_path": hermes_bin or "",
        "version": version,
        "gateway_installed": service_installed_status(),
        "gateway_status": service_runtime_status(),
    }


def system_summary() -> dict[str, Any]:
    disk = shutil.disk_usage(Path.home())
    mem = psutil.virtual_memory()
    uptime_seconds = max(int(time.time() - psutil.boot_time()), 0)
    load_avg: tuple[float, float, float] | None
    try:
        load_avg = os.getloadavg()
    except (AttributeError, OSError):
        load_avg = None

    return {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "hostname": platform.node(),
        "cpu_percent": psutil.cpu_percent(interval=0.15),
        "memory_total": mem.total,
        "memory_used": mem.used,
        "memory_percent": mem.percent,
        "disk_total": disk.total,
        "disk_used": disk.used,
        "disk_free": disk.free,
        "uptime_seconds": uptime_seconds,
        "load_avg": list(load_avg) if load_avg else None,
    }


def list_log_sources() -> list[dict[str, str]]:
    sources: list[dict[str, str]] = []
    if shutil.which("journalctl"):
        sources.append(
            {
                "id": "journal:hermes-gateway",
                "name": "systemd journal (hermes-gateway)",
                "type": "journal",
            }
        )
    if LOG_DIR.exists():
        for path in sorted(LOG_DIR.glob("*.log")):
            sources.append(
                {
                    "id": f"file:{path.name}",
                    "name": f"log file: {path.name}",
                    "type": "file",
                }
            )
    return sources


def tail_lines(path: Path, line_limit: int = 250) -> list[str]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")
    lines = text.splitlines()
    return lines[-line_limit:]


def read_log_source(source: str, keyword: str = "", line_limit: int = 250) -> list[str]:
    keyword_lower = keyword.lower().strip()

    if source == "journal:hermes-gateway":
        result = run_command(
            ["journalctl", "--user", "-u", "hermes-gateway", "-n", str(line_limit), "--no-pager"],
            timeout=20,
        )
        lines = (result["stdout"] or result["stderr"]).splitlines()
    elif source.startswith("file:"):
        file_name = source.split(":", 1)[1]
        if "/" in file_name or "\\" in file_name:
            raise HTTPException(status_code=400, detail="invalid log source")
        path = LOG_DIR / file_name
        if not path.exists():
            raise HTTPException(status_code=404, detail="log file not found")
        lines = tail_lines(path, line_limit=line_limit)
    else:
        raise HTTPException(status_code=400, detail="unsupported log source")

    if keyword_lower:
        lines = [line for line in lines if keyword_lower in line.lower()]
    return lines


def collect_model_targets(config: dict[str, Any]) -> list[ModelTarget]:
    targets: list[ModelTarget] = []
    providers = config.get("providers")
    if isinstance(providers, dict):
        for provider_key, provider_data in providers.items():
            if not isinstance(provider_data, dict):
                continue
            api_base_url = str(provider_data.get("api", "")).strip()
            api_key = str(provider_data.get("api_key", "")).strip()

            models = provider_data.get("models")
            if isinstance(models, list):
                for model_item in models:
                    if isinstance(model_item, str) and model_item.strip():
                        targets.append(
                            ModelTarget(
                                provider_key=provider_key,
                                model=model_item.strip(),
                                api_base_url=api_base_url,
                                api_key=api_key,
                            )
                        )
                    elif isinstance(model_item, dict):
                        candidate_name = str(
                            model_item.get("id")
                            or model_item.get("name")
                            or model_item.get("model")
                            or ""
                        ).strip()
                        if candidate_name:
                            targets.append(
                                ModelTarget(
                                    provider_key=provider_key,
                                    model=candidate_name,
                                    api_base_url=api_base_url,
                                    api_key=api_key,
                                )
                            )

            default_model = str(provider_data.get("default_model", "")).strip()
            if default_model:
                duplicate = any(
                    item.provider_key == provider_key and item.model == default_model for item in targets
                )
                if not duplicate:
                    targets.append(
                        ModelTarget(
                            provider_key=provider_key,
                            model=default_model,
                            api_base_url=api_base_url,
                            api_key=api_key,
                        )
                    )

    model_config = config.get("model")
    if isinstance(model_config, dict):
        default_model = str(model_config.get("default", "")).strip()
        base_url = str(model_config.get("base_url", "")).strip()
        api_key = str(model_config.get("api_key", "")).strip()
        if default_model and base_url:
            duplicate = any(
                item.provider_key == "active" and item.model == default_model for item in targets
            )
            if not duplicate:
                targets.append(
                    ModelTarget(
                        provider_key="active",
                        model=default_model,
                        api_base_url=base_url,
                        api_key=api_key,
                    )
                    )
    return targets


async def ping_model(target: ModelTarget, timeout_seconds: int) -> dict[str, Any]:
    started = time.perf_counter()
    base_url = normalize_api_base(target.api_base_url)
    if not base_url:
        return {
            "provider_key": target.provider_key,
            "model": target.model,
            "ok": False,
            "latency_ms": None,
            "status_code": 0,
            "error": "missing api_base_url",
        }
    url = f"{base_url}/chat/completions"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if target.api_key:
        headers["Authorization"] = f"Bearer {target.api_key}"
    payload = {
        "model": target.model,
        "messages": [{"role": "user", "content": "ping"}],
        "temperature": 0,
        "max_tokens": 8,
    }

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(url, headers=headers, json=payload)
        latency_ms = int((time.perf_counter() - started) * 1000)
        if 200 <= response.status_code < 300:
            return {
                "provider_key": target.provider_key,
                "model": target.model,
                "ok": True,
                "latency_ms": latency_ms,
                "status_code": response.status_code,
                "error": "",
            }
        return {
            "provider_key": target.provider_key,
            "model": target.model,
            "ok": False,
            "latency_ms": latency_ms,
            "status_code": response.status_code,
            "error": response.text[:300],
        }
    except Exception as exc:  # noqa: BLE001
        latency_ms = int((time.perf_counter() - started) * 1000)
        return {
            "provider_key": target.provider_key,
            "model": target.model,
            "ok": False,
            "latency_ms": latency_ms,
            "status_code": 0,
            "error": str(exc),
        }


def sanitize_config_for_ui(config: dict[str, Any]) -> dict[str, Any]:
    providers = config.get("providers")
    provider_list: list[dict[str, Any]] = []
    if isinstance(providers, dict):
        for provider_key, provider_data in providers.items():
            if isinstance(provider_data, dict):
                models: list[str] = []
                raw_models = provider_data.get("models")
                if isinstance(raw_models, list):
                    for item in raw_models:
                        if isinstance(item, str) and item.strip():
                            models.append(item.strip())
                        elif isinstance(item, dict):
                            maybe_name = str(
                                item.get("id") or item.get("name") or item.get("model") or ""
                            ).strip()
                            if maybe_name:
                                models.append(maybe_name)
                default_model = str(provider_data.get("default_model", "")).strip()
                if default_model and default_model not in models:
                    models.append(default_model)

                provider_list.append(
                    {
                        "key": provider_key,
                        "name": provider_data.get("name", provider_key),
                        "api": provider_data.get("api", ""),
                        "api_key": provider_data.get("api_key", ""),
                        "default_model": default_model,
                        "models": models,
                    }
                )
            else:
                provider_list.append(
                    {
                        "key": provider_key,
                        "name": provider_key,
                        "api": "",
                        "api_key": "",
                        "default_model": "",
                        "models": [],
                    }
                )

    model_section = config.get("model") if isinstance(config.get("model"), dict) else {}
    return {
        "raw": config,
        "providers": provider_list,
        "active_model": {
            "provider": model_section.get("provider", ""),
            "base_url": model_section.get("base_url", ""),
            "api_key": model_section.get("api_key", ""),
            "default": model_section.get("default", ""),
        },
    }


def apply_provider_ui_to_config(config: dict[str, Any], providers: list[dict[str, Any]]) -> dict[str, Any]:
    merged = dict(config)
    rebuilt: dict[str, Any] = {}
    for provider in providers:
        provider_key = str(provider.get("key", "")).strip()
        if not provider_key:
            continue
        entry = {
            "name": provider.get("name", provider_key),
            "api": provider.get("api", ""),
            "api_key": provider.get("api_key", ""),
            "default_model": provider.get("default_model", ""),
        }
        models = provider.get("models", [])
        if isinstance(models, list):
            cleaned_models = [str(item).strip() for item in models if str(item).strip()]
            if cleaned_models:
                entry["models"] = cleaned_models
        rebuilt[provider_key] = entry
    merged["providers"] = rebuilt
    return merged


def create_config_backup() -> str:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_name = f"config-{ts}.yaml"
    backup_path = BACKUP_DIR / backup_name
    source_text = read_config_text()
    backup_path.write_text(source_text, encoding="utf-8")
    return backup_name


def serve_frontend_index(request: Request) -> Response:
    if FRONTEND_DIST_INDEX.exists():
        return FileResponse(FRONTEND_DIST_INDEX)
    return templates.TemplateResponse(request, "index.html", {})


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> Response:
    return serve_frontend_index(request)


@app.get("/api/auth/status")
async def auth_status(session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME)) -> dict[str, Any]:
    setup_required = not auth_record_exists()
    return {
        "setup_required": setup_required,
        "authenticated": False if setup_required else is_session_valid(session_token),
    }


@app.post("/api/auth/setup")
async def auth_setup(payload: PasswordPayload, response: Response) -> dict[str, Any]:
    if auth_record_exists():
        raise HTTPException(status_code=409, detail="password already initialized")
    record = password_hash(payload.password)
    write_json_file(AUTH_PATH, record)
    token = create_session()
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,
        max_age=SESSION_TTL_SECONDS,
    )
    return {"ok": True}


@app.post("/api/auth/login")
async def auth_login(payload: PasswordPayload, response: Response) -> dict[str, Any]:
    if not auth_record_exists():
        raise HTTPException(status_code=428, detail="setup_required")
    record = get_auth_record()
    if not verify_password(payload.password, record):
        raise HTTPException(status_code=401, detail="invalid password")
    token = create_session()
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        secure=False,
        max_age=SESSION_TTL_SECONDS,
    )
    return {"ok": True}


@app.post("/api/auth/logout")
async def auth_logout(
    response: Response,
    _auth: str = Depends(require_auth),
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> dict[str, Any]:
    drop_session(session_token)
    response.delete_cookie(SESSION_COOKIE_NAME)
    return {"ok": True}


@app.get("/api/dashboard/state")
async def dashboard_state(_auth: str = Depends(require_auth)) -> dict[str, Any]:
    return {
        "timestamp": now_iso(),
        "hermes": hermes_summary(),
        "system": system_summary(),
        "log_sources": list_log_sources(),
    }


@app.post("/api/service/action")
async def service_action(payload: ServiceActionPayload, _auth: str = Depends(require_auth)) -> dict[str, Any]:
    action = payload.action.strip()
    if action == "gateway_start":
        result = run_hermes(["gateway", "start"])
        return {"ok": result["ok"], "action": action, "result": result}
    if action == "gateway_stop":
        result = run_hermes(["gateway", "stop"])
        return {"ok": result["ok"], "action": action, "result": result}
    if action == "gateway_restart":
        stop_result = run_hermes(["gateway", "stop"])
        start_result = run_hermes(["gateway", "start"])
        return {
            "ok": start_result["ok"],
            "action": action,
            "result": {
                "stop": stop_result,
                "start": start_result,
            },
        }
    if action == "gateway_install":
        result = run_hermes(["gateway", "install"])
        return {"ok": result["ok"], "action": action, "result": result}
    if action == "gateway_uninstall":
        result = run_hermes(["gateway", "uninstall"])
        return {"ok": result["ok"], "action": action, "result": result}
    if action == "version_check":
        result = run_hermes(["--version"])
        return {"ok": result["ok"], "action": action, "result": result}
    if action == "upgrade":
        result = run_hermes(["update"], timeout=300)
        return {"ok": result["ok"], "action": action, "result": result}
    raise HTTPException(status_code=400, detail=f"unsupported action: {action}")


@app.get("/api/config")
async def get_config(_auth: str = Depends(require_auth)) -> dict[str, Any]:
    config = read_config()
    return {
        "ok": True,
        "config_path": str(CONFIG_PATH),
        "raw_yaml": read_config_text(),
        "view": sanitize_config_for_ui(config),
    }


@app.post("/api/config/save")
async def save_config(payload: ConfigSavePayload, _auth: str = Depends(require_auth)) -> dict[str, Any]:
    write_config(payload.config)
    return {"ok": True, "saved_at": now_iso()}


@app.post("/api/config/providers")
async def save_providers(payload: dict[str, Any], _auth: str = Depends(require_auth)) -> dict[str, Any]:
    providers = payload.get("providers")
    if not isinstance(providers, list):
        raise HTTPException(status_code=400, detail="providers must be a list")
    current = read_config()
    merged = apply_provider_ui_to_config(current, providers)
    write_config(merged)
    return {"ok": True, "saved_at": now_iso()}


@app.post("/api/config/raw")
async def save_raw_config(payload: RawConfigPayload, _auth: str = Depends(require_auth)) -> dict[str, Any]:
    try:
        parsed = yaml.safe_load(payload.raw_yaml or "")
    except yaml.YAMLError as exc:
        raise HTTPException(status_code=400, detail=f"invalid yaml: {exc}") from exc
    if parsed is None:
        parsed = {}
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="config root must be a mapping")
    write_config(parsed)
    return {"ok": True, "saved_at": now_iso()}


@app.post("/api/config/backup")
async def backup_config(_auth: str = Depends(require_auth)) -> dict[str, Any]:
    backup_name = create_config_backup()
    return {"ok": True, "backup_name": backup_name, "path": str(BACKUP_DIR / backup_name)}


@app.get("/api/config/backups")
async def list_backups(_auth: str = Depends(require_auth)) -> dict[str, Any]:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backups = sorted(
        [
            {"name": path.name, "mtime": path.stat().st_mtime, "size": path.stat().st_size}
            for path in BACKUP_DIR.glob("config-*.yaml")
            if path.is_file()
        ],
        key=lambda item: item["mtime"],
        reverse=True,
    )
    return {"ok": True, "backups": backups}


@app.post("/api/config/restore")
async def restore_backup(payload: RestorePayload, _auth: str = Depends(require_auth)) -> dict[str, Any]:
    backup_path = BACKUP_DIR / payload.backup_name
    if not backup_path.exists():
        raise HTTPException(status_code=404, detail="backup not found")
    ensure_parent(CONFIG_PATH)
    shutil.copy2(backup_path, CONFIG_PATH)
    return {"ok": True, "restored": payload.backup_name}


@app.post("/api/models/test")
async def test_models(payload: ModelTestPayload, _auth: str = Depends(require_auth)) -> dict[str, Any]:
    if payload.targets:
        targets = payload.targets
    else:
        config = read_config()
        targets = collect_model_targets(config)

    unique_targets: list[ModelTarget] = []
    seen: set[str] = set()
    for target in targets:
        key = f"{target.provider_key}|{target.model}|{target.api_base_url}"
        if key in seen:
            continue
        seen.add(key)
        unique_targets.append(target)

    if not unique_targets:
        return {"ok": False, "results": [], "message": "no test targets found in config"}

    results = await asyncio.gather(
        *(ping_model(target, payload.timeout_seconds) for target in unique_targets)
    )
    return {"ok": True, "results": results, "count": len(results)}


@app.get("/api/logs/sources")
async def logs_sources(_auth: str = Depends(require_auth)) -> dict[str, Any]:
    return {"ok": True, "sources": list_log_sources()}


@app.get("/api/logs/read")
async def logs_read(
    source: str,
    q: str = "",
    limit: int = 250,
    _auth: str = Depends(require_auth),
) -> dict[str, Any]:
    normalized_limit = max(20, min(limit, 1000))
    lines = read_log_source(source=source, keyword=q, line_limit=normalized_limit)
    return {
        "ok": True,
        "source": source,
        "line_count": len(lines),
        "lines": lines,
        "text": "\n".join(lines),
    }


def pick_chat_target(config: dict[str, Any], provider_key: str | None, preferred_model: str | None) -> dict[str, str]:
    model_value = (preferred_model or "").strip()
    if provider_key:
        providers = config.get("providers")
        if isinstance(providers, dict):
            selected = providers.get(provider_key)
            if isinstance(selected, dict):
                model = model_value or str(selected.get("default_model", "")).strip()
                return {
                    "provider_key": provider_key,
                    "api_base_url": str(selected.get("api", "")).strip(),
                    "api_key": str(selected.get("api_key", "")).strip(),
                    "model": model,
                }

    model_section = config.get("model")
    if isinstance(model_section, dict):
        model = model_value or str(model_section.get("default", "")).strip()
        base_url = str(model_section.get("base_url", "")).strip()
        if base_url and model:
            return {
                "provider_key": "active",
                "api_base_url": base_url,
                "api_key": str(model_section.get("api_key", "")).strip(),
                "model": model,
            }

    providers = config.get("providers")
    if isinstance(providers, dict):
        for key, val in providers.items():
            if not isinstance(val, dict):
                continue
            model = model_value or str(val.get("default_model", "")).strip()
            base_url = str(val.get("api", "")).strip()
            if model and base_url:
                return {
                    "provider_key": key,
                    "api_base_url": base_url,
                    "api_key": str(val.get("api_key", "")).strip(),
                    "model": model,
                }
    return {"provider_key": "", "api_base_url": "", "api_key": "", "model": model_value}


def normalize_stream_line(line: str) -> str:
    if not line.startswith("data:"):
        return ""
    payload = line[5:].strip()
    if payload == "[DONE]":
        return ""
    try:
        obj = json.loads(payload)
    except json.JSONDecodeError:
        return ""
    choices = obj.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if isinstance(delta, dict):
        content = delta.get("content")
        if isinstance(content, str):
            return content
    message = first.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return content
    return ""


@app.post("/api/chat/stream")
async def chat_stream(payload: ChatPayload, _auth: str = Depends(require_auth)) -> StreamingResponse:
    config = read_config()
    target = pick_chat_target(config, payload.provider_key, payload.model)
    if not target["api_base_url"] or not target["model"]:
        raise HTTPException(status_code=400, detail="chat target not configured")

    api_base_url = normalize_api_base(target["api_base_url"])
    url = f"{api_base_url}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if target["api_key"]:
        headers["Authorization"] = f"Bearer {target['api_key']}"

    request_payload = {
        "model": target["model"],
        "messages": [message.model_dump() for message in payload.messages],
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
        "stream": True,
    }

    async def generator() -> Any:
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                async with client.stream("POST", url, headers=headers, json=request_payload) as upstream:
                    if upstream.status_code >= 400:
                        body = await upstream.aread()
                        detail = body.decode("utf-8", errors="ignore")[:400]
                        yield f"[error] upstream status {upstream.status_code}: {detail}"
                        return
                    async for line in upstream.aiter_lines():
                        text = normalize_stream_line(line)
                        if text:
                            yield text
        except Exception as exc:  # noqa: BLE001
            yield f"[error] {exc}"

    return StreamingResponse(generator(), media_type="text/plain; charset=utf-8")


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "time": now_iso()}


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str, request: Request) -> Response:
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="not found")

    candidate = FRONTEND_DIST_DIR / full_path
    if full_path and candidate.exists() and candidate.is_file():
        return FileResponse(candidate)

    return serve_frontend_index(request)


@app.exception_handler(HTTPException)
async def http_error_handler(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"ok": False, "detail": exc.detail},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("web_console.backend.app:app", host="0.0.0.0", port=DEFAULT_PORT, reload=False)
