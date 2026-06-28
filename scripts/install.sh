#!/usr/bin/env bash

set -Eeuo pipefail

REPO="${BIKE_REPO:-MoarLiu/Bike}"
GITHUB_BASE="${BIKE_GITHUB_BASE:-https://github.com}"
GITHUB_API="${BIKE_GITHUB_API:-https://api.github.com}"
RAW_BASE="${BIKE_RAW_BASE:-https://raw.githubusercontent.com/${REPO}/main}"
VERSION="${BIKE_VERSION:-latest}"
INSTALL_DIR="${BIKE_INSTALL_DIR:-/opt/bike}"
WEB_SERVICE_NAME="${BIKE_WEB_SERVICE_NAME:-bike-web}"
WEB_SERVICE_USER="${BIKE_WEB_SERVICE_USER:-bike-web}"
SYNC_SERVICE_NAME="${BIKE_SYNC_SERVICE_NAME:-bike-sync-server}"
SYNC_SERVICE_USER="${BIKE_SYNC_SERVICE_USER:-bike-sync}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
NODE_MAJOR="${BIKE_NODE_MAJOR:-22}"
MIN_NODE_VERSION="22.5.0"
NODE_DIST_BASE="${BIKE_NODE_DIST_BASE:-https://nodejs.org/dist}"
MANAGER_PATH="${INSTALL_DIR}/bike.sh"

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
plain='\033[0m'

err() {
  printf "${red}%s${plain}\n" "$*" >&2
}

warn() {
  printf "${yellow}%s${plain}\n" "$*" >&2
}

success() {
  printf "${green}%s${plain}\n" "$*" >&2
}

info() {
  printf "${yellow}%s${plain}\n" "$*" >&2
}

die() {
  err "错误：$*"
  exit 1
}

usage() {
  cat <<EOF
Bike 部署管理脚本

用法：
  curl -fsSL ${RAW_BASE}/scripts/install.sh | bash
  curl -fsSL ${RAW_BASE}/scripts/install.sh | bash -s -- install-web
  curl -fsSL ${RAW_BASE}/scripts/install.sh | bash -s -- install-sync

命令：
  install-web   下载/安装 Bike Web 版并进入引导配置
  configure-web 修改 Bike Web 配置
  update-web    下载最新发布包并重启 Bike Web 服务
  start-web     启动 Bike Web 服务
  restart-web   重启 Bike Web 服务
  status-web    查看 Bike Web 服务状态
  logs-web      查看 Bike Web 服务日志
  install-sync  下载/安装同步服务并进入引导配置
  update-sync   下载最新发布包并重启同步服务
  prepare       只下载/解压发布包，不进入引导配置
  configure     修改同步服务配置
  add-key       添加同步密钥
  start         启动同步服务
  stop          停止同步服务
  restart       重启同步服务
  status        查看同步服务状态
  logs          查看同步服务日志
  health        同步服务健康检查
  uninstall     卸载同步服务，可选择删除安装目录
  update-script 更新本地管理脚本
  menu          打开管理菜单

环境变量：
  BIKE_VERSION=v1.4.2                 安装指定版本；默认 latest
  BIKE_INSTALL_DIR=/opt/bike
  BIKE_WEB_SERVICE_NAME=bike-web
  BIKE_WEB_SERVICE_USER=bike-web
  BIKE_SYNC_SERVICE_NAME=bike-sync-server
  BIKE_SYNC_SERVICE_USER=bike-sync
  BIKE_RAW_BASE=https://raw.githubusercontent.com/MoarLiu/Bike/main
  BIKE_NODE_VERSION=v22.x.y           指定内置 Node.js 版本；默认自动选择 Node 22 最新版
EOF
}

read_tty() {
  local prompt="$1"
  local default="${2:-}"
  local answer
  if tty_available; then
    if [[ -n "${default}" ]]; then
      printf '%s [%s]: ' "${prompt}" "${default}" > /dev/tty
    else
      printf '%s: ' "${prompt}" > /dev/tty
    fi
    IFS= read -r answer < /dev/tty || answer=""
  else
    if [[ -n "${default}" ]]; then
      printf '%s [%s]: ' "${prompt}" "${default}"
    else
      printf '%s: ' "${prompt}"
    fi
    IFS= read -r answer || answer=""
  fi
  printf '%s' "${answer:-${default}}"
}

read_secret_tty() {
  local prompt="$1"
  local answer
  if tty_available; then
    printf '%s: ' "${prompt}" > /dev/tty
    IFS= read -r -s answer < /dev/tty || answer=""
    printf '\n' > /dev/tty
  else
    printf '%s: ' "${prompt}"
    IFS= read -r -s answer || answer=""
    printf '\n'
  fi
  printf '%s' "${answer}"
}

tty_available() {
  [[ -e /dev/tty ]] || return 1
  { : < /dev/tty; } 2>/dev/null
}

confirm() {
  local prompt="$1"
  local default="${2:-N}"
  local answer
  answer="$(read_tty "${prompt}" "${default}")"
  case "${answer}" in
    y|Y|yes|YES|Yes|是) return 0 ;;
    *) return 1 ;;
  esac
}

press_enter() {
  info "* 按回车返回主菜单 *"
  if tty_available; then
    IFS= read -r _ < /dev/tty || true
  else
    IFS= read -r _ || true
  fi
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

run_or_sudo() {
  "$@" 2>/dev/null || sudo_cmd "$@"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "未找到命令：$1"
}

node_version_ok() {
  local node_bin="$1"
  [[ -n "${node_bin}" && -x "${node_bin}" ]] || return 1
  "${node_bin}" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 5)) process.exit(1);
  ' >/dev/null 2>&1
}

node_version_text() {
  local node_bin="$1"
  if [[ -n "${node_bin}" && -x "${node_bin}" ]]; then
    "${node_bin}" -v 2>/dev/null || true
  fi
}

detect_node_platform() {
  case "$(uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'darwin' ;;
    *) die "不支持的系统：$(uname -s)。curl 安装器目前支持 Linux/macOS。" ;;
  esac
}

detect_node_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *) die "不支持的 CPU 架构：$(uname -m)。curl 安装器目前支持 x64/arm64。" ;;
  esac
}

latest_node_version() {
  curl -fsSL "${NODE_DIST_BASE}/index.json" \
    | grep -Eo "\"version\":\"v${NODE_MAJOR}\\.[^\"]+\"" \
    | head -n 1 \
    | sed 's/"version":"//;s/"//'
}

bundled_node_bin() {
  local found
  found="$(find "${INSTALL_DIR}/.node" -path '*/bin/node' -type f 2>/dev/null | sort -r | head -n 1 || true)"
  if [[ -n "${found}" ]]; then
    printf '%s' "${found}"
  fi
}

install_node_runtime() {
  local platform arch node_version archive_name node_parent node_dir archive_path node_url
  platform="$(detect_node_platform)"
  arch="$(detect_node_arch)"
  node_version="${BIKE_NODE_VERSION:-$(latest_node_version)}"
  [[ -n "${node_version}" ]] || die "无法获取 Node.js ${NODE_MAJOR}.x 版本信息。"
  [[ "${node_version}" == v* ]] || node_version="v${node_version}"

  archive_name="node-${node_version}-${platform}-${arch}.tar.xz"
  node_parent="${INSTALL_DIR}/.node"
  node_dir="${node_parent}/node-${node_version}-${platform}-${arch}"
  archive_path="${TMP_DIR}/${archive_name}"
  node_url="${NODE_DIST_BASE}/${node_version}/${archive_name}"

  if [[ ! -x "${node_dir}/bin/node" ]]; then
    info "下载内置 Node.js ${node_version}：${node_url}"
    curl -fL "${node_url}" -o "${archive_path}"
    run_or_sudo mkdir -p "${node_parent}"
    run_or_sudo tar -xJf "${archive_path}" -C "${node_parent}"
  fi

  NODE_BIN="${node_dir}/bin/node"
  node_version_ok "${NODE_BIN}" || die "内置 Node.js 不满足 ${MIN_NODE_VERSION}+：${NODE_BIN}"
  success "使用内置 Node.js：${NODE_BIN} ($("${NODE_BIN}" -v))"
}

ensure_node() {
  local bundled
  if node_version_ok "${NODE_BIN}"; then
    success "使用 Node.js：${NODE_BIN} ($(node_version_text "${NODE_BIN}"))"
    return
  fi

  bundled="$(bundled_node_bin)"
  if node_version_ok "${bundled}"; then
    NODE_BIN="${bundled}"
    success "使用已安装的内置 Node.js：${NODE_BIN} ($("${NODE_BIN}" -v))"
    return
  fi

  if [[ -n "${NODE_BIN}" ]]; then
    warn "当前 Node.js 是 $(node_version_text "${NODE_BIN}")，需要 ${MIN_NODE_VERSION} 或更新版本；将自动安装内置 Node.js ${NODE_MAJOR}.x。"
  else
    warn "未找到 Node.js；将自动安装内置 Node.js ${NODE_MAJOR}.x。"
  fi
  install_node_runtime
}

systemd_available() {
  command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]
}

web_service_installed() {
  [[ -f "/etc/systemd/system/${WEB_SERVICE_NAME}.service" ]]
}

sync_service_installed() {
  [[ -f "/etc/systemd/system/${SYNC_SERVICE_NAME}.service" ]]
}

installed() {
  [[ -x "${INSTALL_DIR}/scripts/setup-sync-server.sh" && -f "${INSTALL_DIR}/server/auth-server.mjs" ]]
}

latest_tag() {
  curl -fsSL "${GITHUB_API}/repos/${REPO}/releases/latest" \
    | sed -n 's/[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}

sha256_check() {
  local expected="$1"
  local file="$2"
  local name
  name="$(basename "${file}")"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "${file}")" && printf '%s  %s\n' "${expected}" "${name}" | sha256sum -c -)
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    (cd "$(dirname "${file}")" && printf '%s  %s\n' "${expected}" "${name}" | shasum -a 256 -c -)
    return
  fi
  die "未找到 sha256sum 或 shasum，无法校验下载文件。"
}

ensure_system_user() {
  local service_user="$1"
  systemd_available || return 0
  id "${service_user}" >/dev/null 2>&1 && return 0

  info "创建 systemd 运行用户：${service_user}"
  if command -v useradd >/dev/null 2>&1; then
    sudo_cmd useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${service_user}"
    return
  fi
  if command -v adduser >/dev/null 2>&1; then
    sudo_cmd adduser --system --home "${INSTALL_DIR}" --no-create-home --disabled-login "${service_user}"
    return
  fi

  warn "未找到 useradd/adduser，将在后续安装时手动选择 systemd 运行用户。"
}

ensure_web_service_user() {
  ensure_system_user "${WEB_SERVICE_USER}"
}

ensure_sync_service_user() {
  ensure_system_user "${SYNC_SERVICE_USER}"
}

refresh_manager_script() {
  local target="${1:-${MANAGER_PATH}}"
  if curl -fsSL "${RAW_BASE}/scripts/install.sh" -o "${TMP_DIR}/bike.sh"; then
    run_or_sudo cp "${TMP_DIR}/bike.sh" "${target}"
    run_or_sudo chmod +x "${target}"
  fi
}

download_release_package() {
  local tag="$1"
  local version_number asset_name checksum_name download_url checksum_url archive_path checksum_path expected_sha
  version_number="${tag#v}"
  asset_name="Bike-Web-${version_number}-sync-server.tar.gz"
  checksum_name="SHA256SUMS-${version_number}.txt"
  download_url="${GITHUB_BASE}/${REPO}/releases/download/${tag}/${asset_name}"
  checksum_url="${GITHUB_BASE}/${REPO}/releases/download/${tag}/${checksum_name}"
  archive_path="${TMP_DIR}/${asset_name}"
  checksum_path="${TMP_DIR}/${checksum_name}"

  info "下载 Bike Web/Sync 部署包 ${tag}：${download_url}"
  curl -fL "${download_url}" -o "${archive_path}"
  curl -fL "${checksum_url}" -o "${checksum_path}"

  expected_sha="$(
    awk -v asset="${asset_name}" '$2 == asset || $2 == "web/" asset { print $1; exit }' "${checksum_path}"
  )"
  [[ -n "${expected_sha}" ]] || die "校验文件中没有找到 ${asset_name}。"
  sha256_check "${expected_sha}" "${archive_path}" >&2

  printf '%s' "${archive_path}"
}

install_or_update_files() {
  local create_sync_service_user="${1:-1}"
  need_command curl
  need_command tar

  local tag archive_path
  tag="${VERSION}"
  if [[ "${tag}" == "latest" ]]; then
    tag="$(latest_tag)"
  fi
  [[ -n "${tag}" ]] || die "无法获取最新 Release 版本。"
  [[ "${tag}" == v* ]] || tag="v${tag}"

  archive_path="$(download_release_package "${tag}")"
  info "安装到：${INSTALL_DIR}"
  run_or_sudo mkdir -p "${INSTALL_DIR}"
  run_or_sudo tar -xzf "${archive_path}" -C "${INSTALL_DIR}"
  run_or_sudo chmod +x "${INSTALL_DIR}/scripts/setup-sync-server.sh"

  if curl -fsSL "${RAW_BASE}/scripts/setup-sync-server.sh" -o "${TMP_DIR}/setup-sync-server.sh"; then
    info "刷新安装脚本：${RAW_BASE}/scripts/setup-sync-server.sh"
    run_or_sudo cp "${TMP_DIR}/setup-sync-server.sh" "${INSTALL_DIR}/scripts/setup-sync-server.sh"
    run_or_sudo chmod +x "${INSTALL_DIR}/scripts/setup-sync-server.sh"
  fi
  refresh_manager_script "${MANAGER_PATH}"
  ensure_node
  if [[ "${create_sync_service_user}" == "1" ]]; then
    ensure_sync_service_user
  fi
  success "Bike Web/Sync 部署包 ${tag} 文件已准备完成。"
}

run_setup() {
  local action="$1"
  installed || die "未找到安装目录：${INSTALL_DIR}。请先执行 install。"
  ensure_node
  if tty_available; then
    sudo_cmd env \
      BIKE_SYNC_CONFIG="${INSTALL_DIR}/config/bike-sync.config.json" \
      BIKE_SYNC_SERVICE_NAME="${SYNC_SERVICE_NAME}" \
      BIKE_SYNC_SERVICE_USER="${SYNC_SERVICE_USER}" \
      NODE_BIN="${NODE_BIN}" \
      bash "${INSTALL_DIR}/scripts/setup-sync-server.sh" "${action}" < /dev/tty
  else
    sudo_cmd env \
      BIKE_SYNC_CONFIG="${INSTALL_DIR}/config/bike-sync.config.json" \
      BIKE_SYNC_SERVICE_NAME="${SYNC_SERVICE_NAME}" \
      BIKE_SYNC_SERVICE_USER="${SYNC_SERVICE_USER}" \
      NODE_BIN="${NODE_BIN}" \
      bash "${INSTALL_DIR}/scripts/setup-sync-server.sh" "${action}"
  fi
}

web_config_path() {
  printf '%s/config/bike.config.json' "${INSTALL_DIR}"
}

write_web_config() {
  local config_path="$1"
  local host="$2"
  local port="$3"
  local username="$4"
  local default_sync_url="$5"
  local secure_cookies="$6"
  local trust_proxy_headers="$7"
  local password="$8"
  local tmp_config

  tmp_config="${TMP_DIR}/bike.config.json"
  printf '%s' "${password}" | env \
    BIKE_WEB_CONFIG_OUT="${tmp_config}" \
    BIKE_PASSWORD_MODULE="${INSTALL_DIR}/server/password.mjs" \
    BIKE_WEB_HOST="${host}" \
    BIKE_WEB_PORT="${port}" \
    BIKE_WEB_USERNAME="${username}" \
    BIKE_WEB_DEFAULT_SYNC_URL="${default_sync_url}" \
    BIKE_WEB_SECURE_COOKIES="${secure_cookies}" \
    BIKE_WEB_TRUST_PROXY_HEADERS="${trust_proxy_headers}" \
    "${NODE_BIN}" --input-type=module -e '
      import fs from "node:fs/promises";
      import { pathToFileURL } from "node:url";

      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const password = Buffer.concat(chunks).toString("utf8");
      if (!password) {
        console.error("登录密码不能为空。");
        process.exit(1);
      }

      const { createSecretHash, createSessionSecret } = await import(
        pathToFileURL(process.env.BIKE_PASSWORD_MODULE).href
      );
      const config = {
        host: process.env.BIKE_WEB_HOST || "127.0.0.1",
        port: Number(process.env.BIKE_WEB_PORT || 4173),
        auth: {
          username: process.env.BIKE_WEB_USERNAME || "me",
          passwordHash: createSecretHash(password),
          sessionSecret: createSessionSecret(),
          sessionMaxAgeHours: 168,
          secureCookies: process.env.BIKE_WEB_SECURE_COOKIES === "true",
          trustProxyHeaders: process.env.BIKE_WEB_TRUST_PROXY_HEADERS === "true",
        },
        web: {
          defaultSyncServerUrl: process.env.BIKE_WEB_DEFAULT_SYNC_URL || "",
        },
        sync: {
          enabled: false,
          databasePath: "data/bike-sync.sqlite",
          deviceTokenHashes: [],
          maxBodyBytes: 10485760,
        },
      };
      await fs.writeFile(
        process.env.BIKE_WEB_CONFIG_OUT,
        `${JSON.stringify(config, null, 2)}\n`,
        { mode: 0o600 },
      );
    '

  run_or_sudo mkdir -p "$(dirname "${config_path}")"
  run_or_sudo cp "${tmp_config}" "${config_path}"
  run_or_sudo chmod 0600 "${config_path}"
  success "已写入 Bike Web 配置：${config_path}"
}

configure_web() {
  tty_available || die "当前环境没有可用 TTY，无法进入 Web 版交互配置。"
  ensure_node

  local config_path host port username default_sync_url secure_cookies trust_proxy password password_confirm
  config_path="$(web_config_path)"
  if [[ -f "${config_path}" ]] && ! confirm "已存在 Web 配置，是否重新配置" "N"; then
    success "保留现有 Web 配置：${config_path}"
    return
  fi

  host="$(read_tty "Web 监听地址" "127.0.0.1")"
  port="$(read_tty "Web 端口" "4173")"
  username="$(read_tty "登录用户名" "me")"
  default_sync_url="$(read_tty "默认同步服务地址，留空表示不预填" "")"
  if confirm "启用安全 Cookie（HTTPS/反向代理场景建议启用）" "N"; then
    secure_cookies="true"
  else
    secure_cookies="false"
  fi
  if confirm "信任反向代理头（Nginx/Caddy/Cloudflare Tunnel 后面可启用）" "N"; then
    trust_proxy="true"
  else
    trust_proxy="false"
  fi

  while true; do
    password="$(read_secret_tty "登录密码（不会回显）")"
    password_confirm="$(read_secret_tty "再次输入登录密码")"
    [[ -n "${password}" ]] || { err "登录密码不能为空。"; continue; }
    [[ "${password}" == "${password_confirm}" ]] || { err "两次输入的登录密码不一致。"; continue; }
    break
  done

  write_web_config "${config_path}" "${host}" "${port}" "${username}" "${default_sync_url}" "${secure_cookies}" "${trust_proxy}" "${password}"
}

install_web_service() {
  ensure_node
  systemd_available || die "当前系统没有可用 systemd，无法安装 Bike Web 系统服务。"
  local config_path default_user service_user service_group data_dir tmp_file
  config_path="$(web_config_path)"
  [[ -f "${config_path}" ]] || die "未找到 Web 配置文件：${config_path}。请先安装或配置 Web 版。"

  default_user="${WEB_SERVICE_USER}"
  if tty_available; then
    service_user="$(read_tty "Bike Web systemd 运行用户" "${default_user}")"
  else
    service_user="${default_user}"
  fi
  id "${service_user}" >/dev/null 2>&1 || die "用户不存在：${service_user}"
  service_group="$(id -gn "${service_user}")"
  data_dir="${INSTALL_DIR}/data"

  sudo_cmd mkdir -p "${data_dir}"
  sudo_cmd chown -R "${service_user}:${service_group}" "${data_dir}"
  sudo_cmd chown "${service_user}:${service_group}" "${config_path}" || true

  tmp_file="$(mktemp)"
  cat > "${tmp_file}" <<EOF
[Unit]
Description=Bike Web
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${service_user}
Group=${service_group}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=BIKE_CONFIG=${config_path}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server/auth-server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${data_dir}

[Install]
WantedBy=multi-user.target
EOF

  sudo_cmd mv "${tmp_file}" "/etc/systemd/system/${WEB_SERVICE_NAME}.service"
  sudo_cmd chmod 0644 "/etc/systemd/system/${WEB_SERVICE_NAME}.service"
  sudo_cmd systemctl daemon-reload
  sudo_cmd systemctl enable "${WEB_SERVICE_NAME}.service"
  success "已安装 Bike Web systemd 服务：${WEB_SERVICE_NAME}.service"
}

start_web_service() {
  if systemd_available && web_service_installed; then
    sudo_cmd systemctl start "${WEB_SERVICE_NAME}.service"
    sudo_cmd systemctl --no-pager --full status "${WEB_SERVICE_NAME}.service" || true
  else
    die "未安装 Bike Web systemd 服务。"
  fi
}

restart_web_service() {
  if systemd_available && web_service_installed; then
    sudo_cmd systemctl restart "${WEB_SERVICE_NAME}.service"
    sudo_cmd systemctl --no-pager --full status "${WEB_SERVICE_NAME}.service" || true
  else
    die "未安装 Bike Web systemd 服务。"
  fi
}

status_web_service() {
  if systemd_available && web_service_installed; then
    sudo_cmd systemctl --no-pager --full status "${WEB_SERVICE_NAME}.service" || true
  else
    die "未安装 Bike Web systemd 服务。"
  fi
}

show_web_logs() {
  if systemd_available && web_service_installed; then
    sudo_cmd journalctl -u "${WEB_SERVICE_NAME}.service" --no-pager -n 120
  else
    die "未安装 Bike Web systemd 服务。"
  fi
}

install_web_action() {
  install_or_update_files 0
  ensure_web_service_user
  configure_web
  if systemd_available; then
    install_web_service
    start_web_service
  else
    success "当前系统没有 systemd，已完成文件和配置准备。可手动执行：BIKE_CONFIG=$(web_config_path) ${NODE_BIN} ${INSTALL_DIR}/server/auth-server.mjs"
  fi
}

update_web_action() {
  install_or_update_files 0
  if web_service_installed; then
    restart_web_service
  else
    success "已更新文件。当前没有安装 Bike Web systemd 服务，未执行重启。"
  fi
}

install_sync_action() {
  install_or_update_files
  tty_available || die "当前环境没有可用 TTY，无法进入交互安装。可执行：curl ... | bash -s -- prepare 只下载解压。"
  run_setup install
}

update_sync_action() {
  install_or_update_files
  if sync_service_installed; then
    run_setup restart
  else
    success "已更新文件。当前没有安装 systemd 服务，未执行重启。"
  fi
}

uninstall_action() {
  if installed; then
    run_setup uninstall-service || true
  elif sync_service_installed; then
    sudo_cmd systemctl disable --now "${SYNC_SERVICE_NAME}.service" || true
    sudo_cmd rm -f "/etc/systemd/system/${SYNC_SERVICE_NAME}.service"
    sudo_cmd systemctl daemon-reload || true
  fi

  if confirm "是否删除安装目录 ${INSTALL_DIR}" "N"; then
    sudo_cmd rm -rf "${INSTALL_DIR}"
    success "已删除安装目录。"
  else
    success "已保留安装目录。"
  fi
}

show_menu() {
  tty_available || {
    usage
    die "当前环境没有可用 TTY，无法进入管理菜单。请使用：bash -s -- install-web/install-sync/status/restart 等命令。"
  }

  while true; do
    clear 2>/dev/null || true
    printf "${green}Bike 部署管理脚本${plain}\n"
    printf -- "--- https://github.com/%s ---\n" "${REPO}"
    printf "${green}0.${plain} 安装 / 重新安装 Bike Web 版\n"
    printf "${green}1.${plain} 安装 / 重新安装同步服务\n"
    printf "${green}2.${plain} 修改同步服务配置\n"
    printf "${green}3.${plain} 添加同步密钥\n"
    printf "${green}4.${plain} 更新 Bike Web 版\n"
    printf "${green}5.${plain} 更新同步服务\n"
    printf "${green}6.${plain} 启动同步服务\n"
    printf "${green}7.${plain} 停止同步服务\n"
    printf "${green}8.${plain} 重启同步服务\n"
    printf "${green}9.${plain} 查看同步服务状态\n"
    printf "${green}10.${plain} 查看同步服务日志\n"
    printf "${green}11.${plain} 同步服务健康检查\n"
    printf "${green}12.${plain} 卸载同步服务\n"
    printf "${green}13.${plain} 更新管理脚本\n"
    printf -- "----------------------------------------\n"
    printf "${green}q.${plain} 退出脚本\n\n"

    local choice
    choice="$(read_tty "请输入选择 [0-13/q]" "")"
    case "${choice}" in
      q|Q|exit|quit) exit 0 ;;
      0) install_web_action; press_enter ;;
      1) install_sync_action; press_enter ;;
      2) run_setup configure; press_enter ;;
      3) run_setup add-key; press_enter ;;
      4) update_web_action; press_enter ;;
      5) update_sync_action; press_enter ;;
      6) run_setup start; press_enter ;;
      7) run_setup stop; press_enter ;;
      8) run_setup restart; press_enter ;;
      9) run_setup status; press_enter ;;
      10) run_setup logs; press_enter ;;
      11) run_setup health; press_enter ;;
      12) uninstall_action; press_enter ;;
      13) refresh_manager_script "${MANAGER_PATH}"; success "管理脚本已更新：${MANAGER_PATH}"; press_enter ;;
      *) err "请输入正确的数字 [0-13]，或输入 q 退出"; press_enter ;;
    esac
  done
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

case "${1:-menu}" in
  install|install-web|web-install) install_web_action ;;
  configure-web|web-configure) configure_web ;;
  install-web-service|web-install-service) install_web_service ;;
  install-sync|sync-install) install_sync_action ;;
  prepare|install-files) install_or_update_files 0 ;;
  update|update-web|web-update) update_web_action ;;
  start-web|web-start) start_web_service ;;
  restart-web|web-restart) restart_web_service ;;
  status-web|web-status) status_web_service ;;
  logs-web|web-logs|log-web|web-log) show_web_logs ;;
  update-sync|sync-update) update_sync_action ;;
  configure) run_setup configure ;;
  add-key) run_setup add-key ;;
  start) run_setup start ;;
  stop) run_setup stop ;;
  restart) run_setup restart ;;
  status) run_setup status ;;
  logs|log) run_setup logs ;;
  health) run_setup health ;;
  uninstall) uninstall_action ;;
  update-script) refresh_manager_script "${MANAGER_PATH}"; success "管理脚本已更新：${MANAGER_PATH}" ;;
  menu) show_menu ;;
  -h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac
