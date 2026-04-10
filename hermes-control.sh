#!/usr/bin/env bash

set -u

APP_NAME="Hermes 控制中心"
APP_VERSION="1.0.0"
INSTALL_URL="https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh"
DEFAULT_HERMES_BIN="$HOME/.hermes/hermes-agent/venv/bin/hermes"

# 终端颜色与样式
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  MAGENTA=$'\033[35m'
  CYAN=$'\033[36m'
  WHITE=$'\033[37m'
  RESET=$'\033[0m'
else
  BOLD=""
  DIM=""
  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  MAGENTA=""
  CYAN=""
  WHITE=""
  RESET=""
fi

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

term_width() {
  local width
  width=$(tput cols 2>/dev/null || printf '96')
  if [[ -z "$width" ]] || ! [[ "$width" =~ ^[0-9]+$ ]]; then
    width=96
  fi
  if (( width < 72 )); then
    width=72
  fi
  printf '%s\n' "$width"
}

repeat_char() {
  local count=$1
  local char=$2
  printf '%*s' "$count" '' | tr ' ' "$char"
}

draw_rule() {
  local char=${1:--}
  local width
  width=$(term_width)
  repeat_char "$width" "$char"
  printf '\n'
}

center_text() {
  local text=$1
  local width padding
  width=$(term_width)
  if (( ${#text} >= width )); then
    printf '%s\n' "$text"
    return
  fi
  padding=$(( (width - ${#text}) / 2 ))
  printf '%*s%s\n' "$padding" '' "$text"
}

style() {
  local color=$1
  shift
  printf '%b%s%b' "$color" "$*" "$RESET"
}

info() {
  printf '%b[i]%b %s\n' "$CYAN" "$RESET" "$*"
}

success() {
  printf '%b[OK]%b %s\n' "$GREEN" "$RESET" "$*"
}

warn() {
  printf '%b[WARN]%b %s\n' "$YELLOW" "$RESET" "$*"
}

error() {
  printf '%b[ERR]%b %s\n' "$RED" "$RESET" "$*"
}

pause_screen() {
  printf '\n'
  read -r -p "按回车键返回控制台..." _
}

trim_text() {
  local text=$1
  local max_length=$2
  if (( ${#text} <= max_length )); then
    printf '%s\n' "$text"
  else
    printf '%s...\n' "${text:0:max_length-3}"
  fi
}

os_label() {
  uname -s 2>/dev/null || printf 'Unknown'
}

shell_label() {
  if [[ -n "${SHELL:-}" ]]; then
    basename "$SHELL"
  else
    printf 'sh'
  fi
}

find_hermes_bin() {
  if has_cmd hermes; then
    command -v hermes
    return 0
  fi

  if [[ -x "$DEFAULT_HERMES_BIN" ]]; then
    printf '%s\n' "$DEFAULT_HERMES_BIN"
    return 0
  fi

  return 1
}

hermes_installed() {
  find_hermes_bin >/dev/null 2>&1
}

hermes_exec() {
  local bin
  if ! bin=$(find_hermes_bin); then
    return 127
  fi
  "$bin" "$@"
}

gateway_running() {
  if ! hermes_installed; then
    return 1
  fi

  if has_cmd systemctl && systemctl --user is-active hermes-gateway >/dev/null 2>&1; then
    return 0
  fi

  if has_cmd pgrep && pgrep -f 'hermes.*gateway|hermes-gateway' >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

installed_badge() {
  if hermes_installed; then
    style "$GREEN$BOLD" "已安装"
  else
    style "$RED$BOLD" "未安装"
  fi
}

gateway_badge() {
  if gateway_running; then
    style "$GREEN$BOLD" "运行中"
  else
    style "$YELLOW$BOLD" "已停止"
  fi
}

version_label() {
  if hermes_installed; then
    hermes_exec --version 2>/dev/null | head -n 1
  else
    printf '未安装'
  fi
}

bin_label() {
  local bin
  if bin=$(find_hermes_bin 2>/dev/null); then
    trim_text "$bin" 56
  else
    printf '未找到'
  fi
}

print_banner() {
  clear
  draw_rule "="
  center_text "$(style "$MAGENTA$BOLD" " _   _                          ____            _             _   ____             _    ")"
  center_text "$(style "$MAGENTA$BOLD" "| | | | ___ _ __ _ __ ___   ___/ ___|___  _ __ | |_ _ __ ___ | | |  _ \\  ___  ___| | __")"
  center_text "$(style "$MAGENTA$BOLD" "| |_| |/ _ \\ '__| '_ \` _ \\ / _ \\ |   / _ \\| '_ \\| __| '__/ _ \\| | | | | |/ _ \\/ __| |/ /")"
  center_text "$(style "$MAGENTA$BOLD" "|  _  |  __/ |  | | | | | |  __/ |__| (_) | | | | |_| | | (_) | | | |_| |  __/ (__|   < ")"
  center_text "$(style "$MAGENTA$BOLD" "|_| |_|\\___|_|  |_| |_| |_|\\___|\\____\\___/|_| |_|\\__|_|  \\___/|_| |____/ \\___|\\___|_|\\_\\")"
  center_text "$(style "$CYAN$BOLD" "$APP_NAME")"
  center_text "$(style "$DIM" "版本 $APP_VERSION")"
  draw_rule "="
}

print_dashboard() {
  local width
  width=$(term_width)

  printf '%b%-18s%b %s\n' "$CYAN$BOLD" "安装状态" "$RESET" "$(installed_badge)"
  printf '%b%-18s%b %s\n' "$CYAN$BOLD" "网关状态" "$RESET" "$(gateway_badge)"
  printf '%b%-18s%b %s\n' "$CYAN$BOLD" "Hermes 版本" "$RESET" "$(version_label)"
  printf '%b%-18s%b %s\n' "$CYAN$BOLD" "程序路径" "$RESET" "$(bin_label)"
  printf '%b%-18s%b %s\n' "$CYAN$BOLD" "操作系统" "$RESET" "$(os_label)"
  printf '%b%-18s%b %s\n' "$CYAN$BOLD" "当前 Shell" "$RESET" "$(shell_label)"
  draw_rule "-"

  center_text "$(style "$BLUE$BOLD" "请选择操作，然后按回车执行")"
  printf '\n'
  printf '  %b[1]%b  一键安装             %b[5]%b  模型管理中心         %b[9]%b   查看网关日志\n' "$GREEN" "$RESET" "$GREEN" "$RESET" "$GREEN" "$RESET"
  printf '  %b[2]%b  启动网关             %b[6]%b  初始化向导           %b[10]%b  环境自检\n' "$GREEN" "$RESET" "$GREEN" "$RESET" "$GREEN" "$RESET"
  printf '  %b[3]%b  停止网关             %b[7]%b  启动对话界面         %b[11]%b  卸载 Hermes\n' "$GREEN" "$RESET" "$GREEN" "$RESET" "$GREEN" "$RESET"
  printf '  %b[4]%b  重启网关             %b[8]%b  更新 Hermes          %b[12]%b  一键添加模型提供商\n' "$GREEN" "$RESET" "$GREEN" "$RESET" "$GREEN" "$RESET"
  printf '  %b[13]%b 启动 Web 控制台      %b[0]%b  退出\n' "$GREEN" "$RESET" "$GREEN" "$RESET"
  printf '\n'
  center_text "$(style "$DIM" "在一个控制面板里完成安装、排障、聊天和日常维护")"

  if (( width > 100 )); then
    printf '\n'
    printf '%b快速说明%b\n' "$YELLOW$BOLD" "$RESET"
    printf '  - 启动、停止、重启前会先检查 Hermes 是否可用。\n'
    printf '  - 日志页优先读取用户服务日志，便于排查网关问题。\n'
    printf '  - 环境自检会集中展示依赖、路径和配置目录状态。\n'
    printf '  - 可直接输入模型 URL、API Key 和模型名，一键写入自定义提供商。\n'
  fi
}

require_hermes() {
  if hermes_installed; then
    return 0
  fi
  error "未检测到 Hermes，请先执行一键安装。"
  pause_screen
  return 1
}

hermes_home_dir() {
  printf '%s\n' "${HERMES_HOME:-$HOME/.hermes}"
}

hermes_code_dir() {
  printf '%s/hermes-agent\n' "$(hermes_home_dir)"
}

hermes_config_file() {
  printf '%s/config.yaml\n' "$(hermes_home_dir)"
}

hermes_env_file() {
  printf '%s/.env\n' "$(hermes_home_dir)"
}

print_installation_snapshot() {
  local home_dir code_dir config_file env_file
  home_dir=$(hermes_home_dir)
  code_dir=$(hermes_code_dir)
  config_file=$(hermes_config_file)
  env_file=$(hermes_env_file)

  printf '%b当前安装路径%b\n' "$YELLOW$BOLD" "$RESET"
  draw_rule "-"
  printf '  %-10s %s\n' "代码目录" "$code_dir"
  printf '  %-10s %s\n' "配置文件" "$config_file"
  printf '  %-10s %s\n' "密钥文件" "$env_file"
  printf '  %-10s %s\n' "数据目录" "$home_dir/cron, $home_dir/sessions, $home_dir/logs"
}

safe_remove_path() {
  local target=$1

  if [[ ! -e "$target" && ! -L "$target" ]]; then
    return 0
  fi

  if [[ "$target" != "$HOME/"* && "$target" != "$HOME" ]]; then
    warn "已跳过非家目录路径，避免误删：$target"
    return 1
  fi

  rm -rf -- "$target"
}

guess_provider_key() {
  local base_url=$1
  local key

  key=${base_url#*://}
  key=${key%%/*}
  key=${key%%\?*}
  key=${key%%:*}
  key=${key#www.}
  key=$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')

  if [[ -z "$key" ]]; then
    key="custom-provider"
  fi

  printf '%s\n' "$key"
}

config_set_value() {
  local key=$1
  local value=${2-}
  hermes_exec config set "$key" "$value"
}

backup_config_file() {
  local config_path backup_path ts
  config_path="$(hermes_home_dir)/config.yaml"

  if [[ ! -f "$config_path" ]]; then
    return 0
  fi

  ts=$(date +"%Y%m%d-%H%M%S" 2>/dev/null || printf 'now')
  backup_path="${config_path}.bak.${ts}"
  cp "$config_path" "$backup_path" 2>/dev/null || return 1
  printf '%s\n' "$backup_path"
}

add_model_provider() {
  local base_url api_key model_name provider_key provider_label backup_path

  clear
  print_banner
  require_hermes || return

  printf '%b一键添加模型提供商%b\n' "$YELLOW$BOLD" "$RESET"
  draw_rule "-"
  printf '请输入 OpenAI 兼容模型接口信息，脚本会自动写入 Hermes 配置。\n'
  printf '示例 URL: https://api.openai.com/v1 或 http://localhost:11434/v1\n\n'

  read -r -p "模型 URL: " base_url
  if [[ -z "${base_url// }" ]]; then
    warn "模型 URL 不能为空。"
    pause_screen
    return
  fi

  if [[ ! "$base_url" =~ ^https?:// ]]; then
    warn "模型 URL 需要以 http:// 或 https:// 开头。"
    pause_screen
    return
  fi

  read -r -s -p "API Key（可留空，输入时隐藏）: " api_key
  printf '\n'

  read -r -p "模型名: " model_name
  if [[ -z "${model_name// }" ]]; then
    warn "模型名不能为空。"
    pause_screen
    return
  fi

  provider_key=$(guess_provider_key "$base_url")
  provider_label="自定义提供商 ${provider_key}"

  backup_path=$(backup_config_file || true)
  if [[ -n "$backup_path" ]]; then
    info "已备份当前配置：$backup_path"
  fi

  info "正在写入自定义提供商配置。"

  if ! config_set_value "providers.${provider_key}.name" "$provider_label"; then
    error "写入提供商名称失败。"
    pause_screen
    return
  fi

  if ! config_set_value "providers.${provider_key}.api" "$base_url"; then
    error "写入提供商地址失败。"
    pause_screen
    return
  fi

  if ! config_set_value "providers.${provider_key}.default_model" "$model_name"; then
    error "写入提供商默认模型失败。"
    pause_screen
    return
  fi

  if ! config_set_value "providers.${provider_key}.api_key" "$api_key"; then
    error "写入提供商 API Key 失败。"
    pause_screen
    return
  fi

  if ! config_set_value "model.provider" "custom"; then
    error "切换当前模型提供商失败。"
    pause_screen
    return
  fi

  if ! config_set_value "model.base_url" "$base_url"; then
    error "写入当前模型 URL 失败。"
    pause_screen
    return
  fi

  if ! config_set_value "model.api_key" "$api_key"; then
    error "写入当前模型 API Key 失败。"
    pause_screen
    return
  fi

  if ! config_set_value "model.default" "$model_name"; then
    error "写入当前模型名失败。"
    pause_screen
    return
  fi

  config_set_value "model.api_mode" "" >/dev/null 2>&1 || true

  printf '\n'
  success "模型提供商已写入完成。"
  printf '  %-14s %s\n' "提供商标识" "$provider_key"
  printf '  %-14s %s\n' "模型 URL" "$base_url"
  printf '  %-14s %s\n' "默认模型" "$model_name"
  printf '  %-14s %s\n' "当前模式" "已切换为该自定义端点"
  printf '\n'
  info "如需进一步调整，可继续进入“模型管理中心”查看。"

  pause_screen
}

launch_web_console() {
  local root_dir script_path python_bin
  root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  script_path="$root_dir/run-web-console.sh"

  clear
  print_banner
  info "准备启动 Web 控制台（端口 15678）。"

  if [[ -x "$script_path" ]]; then
    info "正在执行：$script_path"
    printf '\n'
    "$script_path"
    return
  fi

  if [[ -f "$script_path" ]]; then
    chmod +x "$script_path" >/dev/null 2>&1 || true
    info "正在执行：$script_path"
    printf '\n'
    "$script_path"
    return
  fi

  if has_cmd python3; then
    python_bin="python3"
  elif has_cmd python; then
    python_bin="python"
  else
    error "未检测到 Python，请先安装 Python 3。"
    pause_screen
    return
  fi

  if [[ ! -f "$root_dir/web_console/requirements.txt" || ! -f "$root_dir/web_console/app.py" ]]; then
    error "未检测到 Web 控制台文件（web_console 目录缺失）。"
    pause_screen
    return
  fi

  warn "未找到 run-web-console.sh，将使用内置命令启动。"
  if ! "$python_bin" -m pip install -r "$root_dir/web_console/requirements.txt"; then
    error "依赖安装失败，请检查网络或 Python 环境。"
    pause_screen
    return
  fi

  info "启动成功后请访问：http://127.0.0.1:15678"
  printf '\n'
  "$python_bin" -m uvicorn web_console.app:app --host 0.0.0.0 --port 15678 --app-dir "$root_dir"
}

remove_hermes_launchers() {
  local current_bin target
  local -a candidates=("$HOME/.local/bin/hermes")

  if current_bin=$(find_hermes_bin 2>/dev/null); then
    candidates+=("$current_bin")
  fi

  for target in "${candidates[@]}"; do
    [[ -n "$target" ]] || continue
    [[ -e "$target" || -L "$target" ]] || continue
    [[ "$target" == "$HOME/"* ]] || continue

    if [[ -L "$target" ]]; then
      local link_target
      link_target=$(readlink "$target" 2>/dev/null || true)
      if [[ "$link_target" == *".hermes"* || "$target" == "$HOME/.local/bin/hermes" ]]; then
        rm -f -- "$target"
      fi
      continue
    fi

    if [[ "$target" == "$HOME/.local/bin/hermes" ]] || grep -qE '\.hermes|hermes-agent' "$target" 2>/dev/null; then
      rm -f -- "$target"
    fi
  done
}

cleanup_gateway_service_artifacts() {
  local home_dir user_service wants_service
  home_dir=$(hermes_home_dir)
  user_service="$HOME/.config/systemd/user/hermes-gateway.service"
  wants_service="$HOME/.config/systemd/user/default.target.wants/hermes-gateway.service"

  info "检查并停止网关服务。"

  if has_cmd systemctl; then
    systemctl --user stop hermes-gateway >/dev/null 2>&1 || true
    systemctl --user disable hermes-gateway >/dev/null 2>&1 || true
  fi

  if has_cmd pkill; then
    pkill -f 'hermes.*gateway|hermes-gateway' >/dev/null 2>&1 || true
  fi

  safe_remove_path "$user_service" >/dev/null 2>&1 || true
  safe_remove_path "$wants_service" >/dev/null 2>&1 || true
  safe_remove_path "$home_dir/hermes-gateway.service" >/dev/null 2>&1 || true

  if has_cmd systemctl; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
}

manual_uninstall_code_only() {
  local code_dir
  code_dir=$(hermes_code_dir)

  info "执行手动卸载：仅删除程序代码，保留配置和数据。"
  cleanup_gateway_service_artifacts
  remove_hermes_launchers

  if safe_remove_path "$code_dir"; then
    success "已删除代码目录：$code_dir"
  else
    warn "代码目录删除时出现异常：$code_dir"
  fi

  success "配置和数据已保留。"
}

manual_uninstall_full() {
  local home_dir
  home_dir=$(hermes_home_dir)

  info "执行手动完全卸载。"
  cleanup_gateway_service_artifacts
  remove_hermes_launchers

  if safe_remove_path "$home_dir"; then
    success "已删除 Hermes 目录：$home_dir"
  else
    warn "Hermes 目录删除时出现异常：$home_dir"
  fi
}

confirm_full_uninstall() {
  local confirm home_dir
  home_dir=$(hermes_home_dir)

  printf '\n'
  warn "完全卸载会删除 $home_dir 下的配置、日志和会话数据。"
  read -r -p "继续完全卸载？[y/N]: " confirm
  [[ "$confirm" =~ ^[Yy]$ ]]
}

fallback_uninstall_menu() {
  local action

  printf '\n'
  warn "官方卸载命令执行失败，可改用手动卸载。"
  printf '%b手动卸载选项%b\n' "$YELLOW$BOLD" "$RESET"
  draw_rule "-"
  printf '  [1] 保留数据：仅删除程序代码、启动器和网关服务\n'
  printf '  [2] 完全卸载：删除整个 Hermes 目录及相关启动器\n'
  printf '  [0] 返回\n\n'

  read -r -p "请选择 [1/2/0]: " action

  case "$action" in
    1)
      manual_uninstall_code_only
      ;;
    2)
      if confirm_full_uninstall; then
        manual_uninstall_full
      else
        warn "已取消完全卸载。"
      fi
      ;;
    *)
      warn "已取消卸载。"
      ;;
  esac
}

run_installer_stream() {
  if has_cmd curl; then
    curl -fsSL "$INSTALL_URL" | bash
    return $?
  fi

  if has_cmd wget; then
    wget -qO- "$INSTALL_URL" | bash
    return $?
  fi

  return 127
}

quick_install() {
  clear
  print_banner
  info "准备安装 Hermes Agent。"

  if hermes_installed; then
    warn "检测到 Hermes 已存在，将继续执行网关初始化和启动。"
  else
    info "拉取官方安装脚本并执行。"
    if ! run_installer_stream; then
      error "安装脚本执行失败，请检查网络、curl/wget 或脚本权限。"
      pause_screen
      return
    fi
    success "Hermes 安装脚本执行完成。"
  fi

  info "初始化网关服务。"
  hermes_exec gateway install >/dev/null 2>&1 || true

  if hermes_exec gateway start; then
    success "网关已启动。"
  else
    warn "网关启动命令返回异常，请稍后查看日志。"
  fi

  pause_screen
}

start_gateway() {
  clear
  print_banner
  require_hermes || return

  if gateway_running; then
    warn "网关已在运行。"
    pause_screen
    return
  fi

  info "正在启动网关。"
  hermes_exec gateway install >/dev/null 2>&1 || true
  if hermes_exec gateway start; then
    success "网关启动成功。"
  else
    error "网关启动失败。"
  fi

  pause_screen
}

stop_gateway() {
  clear
  print_banner
  require_hermes || return

  if ! gateway_running; then
    warn "网关当前未运行。"
    pause_screen
    return
  fi

  info "正在停止网关。"
  if hermes_exec gateway stop; then
    success "网关已停止。"
  else
    error "网关停止失败。"
  fi

  pause_screen
}

restart_gateway() {
  clear
  print_banner
  require_hermes || return

  info "正在重启网关。"
  hermes_exec gateway stop >/dev/null 2>&1 || true
  if hermes_exec gateway start; then
    success "网关重启完成。"
  else
    error "网关重启失败。"
  fi

  pause_screen
}

open_model_center() {
  clear
  print_banner
  require_hermes || return
  info "进入模型管理中心。退出后会自动返回控制台。"
  printf '\n'
  hermes_exec model
}

run_setup_wizard() {
  clear
  print_banner
  require_hermes || return
  info "进入初始化配置向导。"
  printf '\n'
  hermes_exec setup
}

launch_chat() {
  clear
  print_banner
  require_hermes || return
  info "进入 Hermes 交互式对话，输入 /exit 返回控制台。"
  printf '\n'
  hermes_exec
}

update_hermes() {
  clear
  print_banner
  require_hermes || return
  info "检查并更新 Hermes。"
  if hermes_exec update; then
    success "更新流程执行完成。"
  else
    error "更新失败。"
  fi
  pause_screen
}

view_gateway_logs() {
  clear
  print_banner
  require_hermes || return

  if has_cmd journalctl; then
    info "显示最近 80 行网关日志。"
    printf '\n'
    journalctl --user -u hermes-gateway -n 80 --no-pager 2>/dev/null || warn "未读取到 systemd 用户服务日志。"
  else
    warn "当前环境缺少 journalctl，无法直接读取用户服务日志。"
    if gateway_running; then
      info "网关正在运行，可手动结合 ps/pgrep 排查。"
    else
      info "网关当前未运行。"
    fi
  fi

  pause_screen
}

system_check() {
  clear
  print_banner

  printf '%b环境自检%b\n' "$YELLOW$BOLD" "$RESET"
  draw_rule "-"
  printf '%-22s %s\n' "curl"        "$(has_cmd curl && printf '可用' || printf '不可用')"
  printf '%-22s %s\n' "wget"        "$(has_cmd wget && printf '可用' || printf '不可用')"
  printf '%-22s %s\n' "systemctl"   "$(has_cmd systemctl && printf '可用' || printf '不可用')"
  printf '%-22s %s\n' "journalctl"  "$(has_cmd journalctl && printf '可用' || printf '不可用')"
  printf '%-22s %s\n' "pgrep"       "$(has_cmd pgrep && printf '可用' || printf '不可用')"
  printf '%-22s %s\n' "hermes"      "$(hermes_installed && printf '已安装' || printf '未安装')"
  printf '%-22s %s\n' "网关"        "$(gateway_running && printf '运行中' || printf '已停止')"
  printf '%-22s %s\n' "配置目录"    "$([[ -d "$HOME/.hermes" ]] && printf '%s' "$HOME/.hermes" || printf '缺失')"
  printf '%-22s %s\n' "程序路径"    "$(bin_label)"
  draw_rule "-"

  if hermes_installed; then
    printf '\n%b版本快照%b\n' "$YELLOW$BOLD" "$RESET"
    hermes_exec --version 2>/dev/null | head -n 3
  fi

  pause_screen
}

uninstall_hermes() {
  local action

  clear
  print_banner
  require_hermes || return

  printf '%b卸载 Hermes%b\n' "$RED$BOLD" "$RESET"
  printf '请选择卸载方式；只有“完全卸载”会再进行一次确认。\n\n'
  print_installation_snapshot
  printf '\n'
  draw_rule "-"
  printf '  [1] 推荐卸载：调用 Hermes 官方卸载命令\n'
  printf '  [2] 保留数据：仅删除程序代码、启动器和网关服务\n'
  printf '  [3] 完全卸载：删除整个 Hermes 目录及相关启动器\n'
  printf '  [0] 返回\n\n'

  read -r -p "请选择 [1/2/3/0]: " action

  case "$action" in
    1)
      if hermes_exec uninstall; then
        success "Hermes 已卸载。"
      else
        error "官方卸载命令执行失败。"
        fallback_uninstall_menu
      fi
      ;;
    2)
      manual_uninstall_code_only
      ;;
    3)
      if confirm_full_uninstall; then
        manual_uninstall_full
      else
        warn "已取消完全卸载。"
      fi
      ;;
    *)
      warn "已取消卸载。"
      ;;
  esac

  pause_screen
}

exit_app() {
  clear
  draw_rule "="
  center_text "$(style "$GREEN$BOLD" "Hermes 控制中心已关闭")"
  center_text "$(style "$DIM" "欢迎下次再来。")"
  draw_rule "="
  exit 0
}

handle_choice() {
  local choice=$1

  case "$choice" in
    1) quick_install ;;
    2) start_gateway ;;
    3) stop_gateway ;;
    4) restart_gateway ;;
    5) open_model_center ;;
    6) run_setup_wizard ;;
    7) launch_chat ;;
    8) update_hermes ;;
    9) view_gateway_logs ;;
    10) system_check ;;
    11) uninstall_hermes ;;
    12) add_model_provider ;;
    13) launch_web_console ;;
    0|q|Q|exit) exit_app ;;
    *)
      warn "无效选项，请输入 0 到 13。"
      sleep 1
      ;;
  esac
}

main_loop() {
  while true; do
    print_banner
    print_dashboard
    printf '\n'
    read -r -p "请选择> " user_choice
    handle_choice "${user_choice:-}"
  done
}

main_loop
