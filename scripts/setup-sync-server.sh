#!/usr/bin/env bash

set -Eeuo pipefail

systemd_quote() {
  local value="$1"
  [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] || die "systemd 路径不能包含换行。"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "${value}"
}


SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
NODE_SCRIPT="${PROJECT_ROOT}/scripts/setup-sync-server.mjs"
CONFIG_PATH="${BIKE_SYNC_CONFIG:-${PROJECT_ROOT}/config/bike-sync.config.json}"
SERVICE_NAME="${BIKE_SYNC_SERVICE_NAME:-bike-sync-server}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

say() {
  printf '%s\n' "$*"
}

die() {
  say "错误：$*" >&2
  exit 1
}

need_node() {
  if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
    die "未找到 Node.js。同步服务需要 Node.js 22.13.0 或更新版本。"
  fi

  "${NODE_BIN}" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 13)) {
      console.error(`当前 Node.js 是 ${process.versions.node}，需要 22.13.0 或更新版本。`);
      process.exit(1);
    }
    try { require("node:sqlite"); } catch {
      console.error("当前 Node.js 无法使用 node:sqlite，请安装 Node.js 22.13.0 或更新的 LTS 版本。");
      process.exit(1);
    }
  ' || exit 1
}

sudo_cmd() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi
  die "此操作需要 root 权限，请使用 sudo 或 root 用户执行。"
}

systemd_available() {
  command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]
}

service_installed() {
  [[ -f "${SERVICE_FILE}" ]]
}

resolve_database_dir() {
  "${NODE_BIN}" -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.argv[1];
    const configPath = process.argv[2];
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const databasePath = config.databasePath || "data/bike-sync.sqlite";
    console.log(path.dirname(path.resolve(root, databasePath)));
  ' "${PROJECT_ROOT}" "${CONFIG_PATH}"
}

resolve_database_path() {
  "${NODE_BIN}" -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.argv[1];
    const configPath = process.argv[2];
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const databasePath = config.databasePath || "data/bike-sync.sqlite";
    console.log(path.resolve(root, databasePath));
  ' "${PROJECT_ROOT}" "${CONFIG_PATH}"
}

assert_safe_writable_dir() {
  local target="$1"
  [[ ! -L "${target}" ]] || die "SQLite 数据库目录不能是符号链接。"
  if [[ "${target}" == "${PROJECT_ROOT}/data" || "${target}" == "${PROJECT_ROOT}/data/"* ]]; then return; fi
  case "${target}" in
    /|/bin|/boot|/dev|/etc|/etc/*|/home|/home/*|/lib|/lib64|/opt|/proc|/root|/root/*|/run|/sbin|/sys|/tmp|/usr|/usr/local|/usr/*|/var|/var/lib|/srv|/Users|/Users/*)
      die "SQLite 数据库目录不能直接使用系统目录：${target}。请改成专用目录，例如 /var/lib/bike-sync。"
      ;;
  esac
}

run_node_setup() {
  need_node
  cd "${PROJECT_ROOT}"
  BIKE_SYNC_CONFIG="${CONFIG_PATH}" "${NODE_BIN}" "${NODE_SCRIPT}" "$@"
}

default_service_user() {
  if [[ -n "${BIKE_SYNC_SERVICE_USER:-}" ]]; then
    printf '%s' "${BIKE_SYNC_SERVICE_USER}"
    return
  fi
  if id bike-sync >/dev/null 2>&1 || [[ "$(id -u)" == 0 ]]; then
    printf 'bike-sync'
  elif id bike-web >/dev/null 2>&1; then
    printf 'bike-web'
  else
    id -un
  fi
}

install_service() {
  need_node
  systemd_available || die "当前系统没有可用 systemd，无法安装系统服务。"
  [[ -f "${CONFIG_PATH}" ]] || die "未找到配置文件：${CONFIG_PATH}。请先执行 configure。"

  local default_user service_user service_group data_dir database_dir database_path
  default_user="$(default_service_user)"
  read -r -p "systemd 运行用户 [${default_user}]: " service_user
  service_user="${service_user:-${default_user}}"
  [[ "${service_user}" != root ]] || die "同步服务不能使用 root，请选择专用服务用户。"
  if ! id "${service_user}" >/dev/null 2>&1 && [[ "${service_user}" == bike-sync && "$(id -u)" == 0 ]]; then
    command -v useradd >/dev/null 2>&1 || die "请先创建 bike-sync 系统用户。"
    useradd --system --user-group --no-create-home --home-dir "${PROJECT_ROOT}" --shell /usr/sbin/nologin bike-sync
  fi
  id "${service_user}" >/dev/null 2>&1 || die "用户不存在：${service_user}"
  service_group="$(id -gn "${service_user}")"
  data_dir="${PROJECT_ROOT}/data"
  database_dir="$(resolve_database_dir)"
  database_path="$(resolve_database_path)"
  assert_safe_writable_dir "${database_dir}"
  [[ ! -L "${data_dir}" && ! -L "${database_path}" ]] || die "数据目录与数据库文件不能是符号链接。"
  if [[ -d "${database_dir}" && "${database_dir}" != "${data_dir}" ]]; then
    "${NODE_BIN}" -e '
      const fs = require("fs"), dir = process.argv[1], owner = Number(process.argv[2]);
      const stat = fs.statSync(dir);
      if (fs.readdirSync(dir).length && (stat.uid !== owner || (stat.mode & 0o077))) {
        console.error("已有数据库目录必须是服务用户拥有的私有专用目录；拒绝更改其它目录的属主或权限。"); process.exit(1);
      }
    ' "${database_dir}" "$(id -u "${service_user}")"
  fi

  sudo_cmd mkdir -p "${data_dir}"
  sudo_cmd mkdir -p "${database_dir}"
  sudo_cmd chown -R "${service_user}:${service_group}" "${data_dir}"
  sudo_cmd chown "${service_user}:${service_group}" "${database_dir}"
  [[ ! -e "${database_path}" ]] || sudo_cmd chown "${service_user}:${service_group}" "${database_path}"
  sudo_cmd chown "${service_user}:${service_group}" "${CONFIG_PATH}" || true
  sudo_cmd chmod 0600 "${CONFIG_PATH}"
  sudo_cmd chmod 0700 "${database_dir}"
  for private_file in "${database_path}" "${database_path}-wal" "${database_path}-shm"; do
    [[ ! -f "${private_file}" ]] || sudo_cmd chmod 0600 "${private_file}"
  done

  local tmp_file
  tmp_file="$(mktemp)"
  cat > "${tmp_file}" <<EOF
[Unit]
Description=Bike Sync Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${service_user}
Group=${service_group}
WorkingDirectory=$(systemd_quote "${PROJECT_ROOT}")
Environment=NODE_ENV=production
Environment=$(systemd_quote "BIKE_SYNC_CONFIG=${CONFIG_PATH}")
ExecStart=$(systemd_quote "${NODE_BIN//\$/\$\$}") $(systemd_quote "${PROJECT_ROOT//\$/\$\$}/server/sync-server.mjs")
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
UMask=0077
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$(systemd_quote "${data_dir}")
ReadWritePaths=$(systemd_quote "${database_dir}")

[Install]
WantedBy=multi-user.target
EOF

  sudo_cmd mv "${tmp_file}" "${SERVICE_FILE}"
  sudo_cmd chmod 0644 "${SERVICE_FILE}"
  sudo_cmd systemctl daemon-reload
  sudo_cmd systemctl enable "${SERVICE_NAME}.service"
  say "已安装 systemd 服务：${SERVICE_NAME}.service"
  say "启动命令：${BASH_SOURCE[0]} start"
}

uninstall_service() {
  systemd_available || die "当前系统没有可用 systemd。"
  if service_installed; then
    sudo_cmd systemctl disable --now "${SERVICE_NAME}.service" || true
    sudo_cmd rm -f "${SERVICE_FILE}"
    sudo_cmd systemctl daemon-reload
    say "已卸载 systemd 服务：${SERVICE_NAME}.service"
  else
    say "未安装 systemd 服务：${SERVICE_NAME}.service"
  fi
}

install_all() {
  if ! systemd_available && [[ "$(id -u)" == 0 ]]; then
    die "无 systemd 时请以普通用户运行同步服务；尚未修改配置。"
  fi
  run_node_setup configure
  if systemd_available; then
    install_service
  else
    say "当前系统没有可用 systemd，将使用脚本后台进程启动。"
  fi
  if systemd_available && service_installed; then
    restart_service
  else
    start_service
  fi
  health_check || true
}

start_service() {
  if systemd_available && service_installed; then
    sudo_cmd systemctl start "${SERVICE_NAME}.service"
    sudo_cmd systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
  else
    run_node_setup start
  fi
}

stop_service() {
  if systemd_available && service_installed; then
    sudo_cmd systemctl stop "${SERVICE_NAME}.service"
    say "已停止 systemd 服务：${SERVICE_NAME}.service"
  else
    run_node_setup stop
  fi
}

restart_service() {
  if systemd_available && service_installed; then
    sudo_cmd systemctl restart "${SERVICE_NAME}.service"
    sudo_cmd systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
  else
    run_node_setup restart
  fi
}

status_service() {
  if systemd_available && service_installed; then
    sudo_cmd systemctl --no-pager --full status "${SERVICE_NAME}.service" || true
  else
    run_node_setup status
  fi
}

show_logs() {
  if systemd_available && service_installed; then
    sudo_cmd journalctl -u "${SERVICE_NAME}.service" --no-pager -n 120
  else
    local log_file="${PROJECT_ROOT}/data/bike-sync-server.log"
    [[ -f "${log_file}" ]] || die "未找到日志文件：${log_file}"
    tail -n 120 "${log_file}"
  fi
}

health_check() {
  need_node
  [[ -f "${CONFIG_PATH}" ]] || die "未找到配置文件：${CONFIG_PATH}。"
  local target
  target="$("${NODE_BIN}" -e '
    const fs = require("fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const host = ["", "0.0.0.0", "::"].includes(String(config.host || "")) ? "127.0.0.1" : config.host;
    const port = config.port || 4174;
    console.log(`http://${host}:${port}/healthz`);
  ' "${CONFIG_PATH}")"
  say "检查：${target}"
  curl -fsS "${target}" && printf '\n'
}

show_menu() {
  while true; do
    cat <<EOF

Bike 同步服务部署
1. 一键配置并安装/启动
2. 配置同步服务
3. 添加同步密钥
4. 安装 systemd 服务
5. 启动同步服务
6. 重启同步服务
7. 停止同步服务
8. 查看状态
9. 查看日志
10. 健康检查
11. 卸载 systemd 服务
0. 退出
EOF
    read -r -p "请选择 [1]: " choice
    choice="${choice:-1}"
    case "${choice}" in
      1) install_all ;;
      2) run_node_setup configure ;;
      3) run_node_setup add-key ;;
      4) install_service ;;
      5) start_service ;;
      6) restart_service ;;
      7) stop_service ;;
      8) status_service ;;
      9) show_logs ;;
      10) health_check ;;
      11) uninstall_service ;;
      0) exit 0 ;;
      *) say "未知选项：${choice}" ;;
    esac
  done
}

usage() {
  cat <<EOF
用法：
  ./scripts/setup-sync-server.sh [命令]

命令：
  install            一键配置、安装 systemd 服务并启动
  configure          配置同步服务
  add-key            添加同步密钥
  install-service    安装 systemd 服务
  uninstall-service  卸载 systemd 服务
  start              启动同步服务
  stop               停止同步服务
  restart            重启同步服务
  status             查看状态
  logs               查看日志
  health             健康检查
  menu               打开交互菜单

环境变量：
  BIKE_SYNC_CONFIG=/path/to/bike-sync.config.json
  BIKE_SYNC_SERVICE_NAME=bike-sync-server
  BIKE_SYNC_SERVICE_USER=bike-sync
  NODE_BIN=/path/to/node
EOF
}

action="${1:-menu}"

case "${action}" in
  install|setup) install_all ;;
  configure) run_node_setup configure ;;
  add-key) run_node_setup add-key ;;
  install-service) install_service ;;
  uninstall-service) uninstall_service ;;
  start) start_service ;;
  stop) stop_service ;;
  restart) restart_service ;;
  status) status_service ;;
  logs) show_logs ;;
  health) health_check ;;
  menu) show_menu ;;
  -h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac
