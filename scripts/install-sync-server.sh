#!/usr/bin/env bash

set -Eeuo pipefail

REPO="${BIKE_REPO:-MoarLiu/Bike}"
GITHUB_BASE="${BIKE_GITHUB_BASE:-https://github.com}"
GITHUB_API="${BIKE_GITHUB_API:-https://api.github.com}"
RAW_BASE="${BIKE_RAW_BASE:-https://raw.githubusercontent.com/${REPO}/main}"
VERSION="${BIKE_VERSION:-latest}"
INSTALL_DIR="${BIKE_INSTALL_DIR:-/opt/bike-sync-server}"
SERVICE_NAME="${BIKE_SYNC_SERVICE_NAME:-bike-sync-server}"
SERVICE_USER="${BIKE_SYNC_SERVICE_USER:-bike-sync}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
NODE_MAJOR="${BIKE_NODE_MAJOR:-22}"
MIN_NODE_VERSION="22.5.0"
NODE_DIST_BASE="${BIKE_NODE_DIST_BASE:-https://nodejs.org/dist}"
MANAGER_PATH="${INSTALL_DIR}/bike-sync.sh"

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
Bike Sync Server 管理脚本

用法：
  curl -fsSL ${RAW_BASE}/scripts/install-sync-server.sh | bash
  curl -fsSL ${RAW_BASE}/scripts/install-sync-server.sh | bash -s -- install

命令：
  install      下载/安装并进入引导配置
  prepare      只下载/解压发布包，不进入引导配置
  update       下载最新发布包并重启服务
  configure    修改同步服务配置
  add-key      添加同步密钥
  start        启动服务
  stop         停止服务
  restart      重启服务
  status       查看服务状态
  logs         查看日志
  health       健康检查
  uninstall    卸载 systemd 服务，可选择删除安装目录
  update-script 更新本地管理脚本
  menu         打开管理菜单

环境变量：
  BIKE_VERSION=v1.4.2                 安装指定版本；默认 latest
  BIKE_INSTALL_DIR=/opt/bike-sync-server
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

service_installed() {
  [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]
}

installed() {
  [[ -x "${INSTALL_DIR}/scripts/setup-sync-server.sh" ]]
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

ensure_service_user() {
  systemd_available || return 0
  id "${SERVICE_USER}" >/dev/null 2>&1 && return 0

  info "创建 systemd 运行用户：${SERVICE_USER}"
  if command -v useradd >/dev/null 2>&1; then
    sudo_cmd useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
    return
  fi
  if command -v adduser >/dev/null 2>&1; then
    sudo_cmd adduser --system --home "${INSTALL_DIR}" --no-create-home --disabled-login "${SERVICE_USER}"
    return
  fi

  warn "未找到 useradd/adduser，将在后续安装时手动选择 systemd 运行用户。"
}

refresh_manager_script() {
  local target="${1:-${MANAGER_PATH}}"
  if curl -fsSL "${RAW_BASE}/scripts/install-sync-server.sh" -o "${TMP_DIR}/bike-sync.sh"; then
    run_or_sudo cp "${TMP_DIR}/bike-sync.sh" "${target}"
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

  info "下载 Bike Sync Server ${tag}：${download_url}"
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
  local create_service_user="${1:-1}"
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
  if [[ "${create_service_user}" == "1" ]]; then
    ensure_service_user
  fi
  success "Bike Sync Server ${tag} 文件已准备完成。"
}

run_setup() {
  local action="$1"
  installed || die "未找到安装目录：${INSTALL_DIR}。请先执行 install。"
  ensure_node
  if tty_available; then
    sudo_cmd env \
      BIKE_SYNC_CONFIG="${INSTALL_DIR}/config/bike-sync.config.json" \
      BIKE_SYNC_SERVICE_NAME="${SERVICE_NAME}" \
      BIKE_SYNC_SERVICE_USER="${SERVICE_USER}" \
      NODE_BIN="${NODE_BIN}" \
      bash "${INSTALL_DIR}/scripts/setup-sync-server.sh" "${action}" < /dev/tty
  else
    sudo_cmd env \
      BIKE_SYNC_CONFIG="${INSTALL_DIR}/config/bike-sync.config.json" \
      BIKE_SYNC_SERVICE_NAME="${SERVICE_NAME}" \
      BIKE_SYNC_SERVICE_USER="${SERVICE_USER}" \
      NODE_BIN="${NODE_BIN}" \
      bash "${INSTALL_DIR}/scripts/setup-sync-server.sh" "${action}"
  fi
}

install_action() {
  install_or_update_files
  tty_available || die "当前环境没有可用 TTY，无法进入交互安装。可执行：curl ... | bash -s -- prepare 只下载解压。"
  run_setup install
}

update_action() {
  install_or_update_files
  if service_installed; then
    run_setup restart
  else
    success "已更新文件。当前没有安装 systemd 服务，未执行重启。"
  fi
}

uninstall_action() {
  if installed; then
    run_setup uninstall-service || true
  elif service_installed; then
    sudo_cmd systemctl disable --now "${SERVICE_NAME}.service" || true
    sudo_cmd rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
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
    die "当前环境没有可用 TTY，无法进入管理菜单。请使用：bash -s -- install/status/restart 等命令。"
  }

  while true; do
    clear 2>/dev/null || true
    printf "${green}Bike Sync Server 管理脚本${plain}\n"
    printf -- "--- https://github.com/%s ---\n" "${REPO}"
    printf "${green}1.${plain} 安装 / 重新安装同步服务\n"
    printf "${green}2.${plain} 修改同步服务配置\n"
    printf "${green}3.${plain} 添加同步密钥\n"
    printf "${green}4.${plain} 更新同步服务\n"
    printf "${green}5.${plain} 启动同步服务\n"
    printf "${green}6.${plain} 停止同步服务\n"
    printf "${green}7.${plain} 重启同步服务\n"
    printf "${green}8.${plain} 查看服务状态\n"
    printf "${green}9.${plain} 查看服务日志\n"
    printf "${green}10.${plain} 健康检查\n"
    printf "${green}11.${plain} 卸载同步服务\n"
    printf "${green}12.${plain} 更新管理脚本\n"
    printf -- "----------------------------------------\n"
    printf "${green}0.${plain} 退出脚本\n\n"

    local choice
    choice="$(read_tty "请输入选择 [0-12]" "")"
    case "${choice}" in
      0) exit 0 ;;
      1) install_action; press_enter ;;
      2) run_setup configure; press_enter ;;
      3) run_setup add-key; press_enter ;;
      4) update_action; press_enter ;;
      5) run_setup start; press_enter ;;
      6) run_setup stop; press_enter ;;
      7) run_setup restart; press_enter ;;
      8) run_setup status; press_enter ;;
      9) run_setup logs; press_enter ;;
      10) run_setup health; press_enter ;;
      11) uninstall_action; press_enter ;;
      12) refresh_manager_script "${MANAGER_PATH}"; success "管理脚本已更新：${MANAGER_PATH}"; press_enter ;;
      *) err "请输入正确的数字 [0-12]"; press_enter ;;
    esac
  done
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

case "${1:-menu}" in
  install) install_action ;;
  prepare|install-files) install_or_update_files 0 ;;
  update) update_action ;;
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
