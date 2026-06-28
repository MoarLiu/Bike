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
RUN_INSTALL="${BIKE_RUN_INSTALL:-1}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
NODE_MAJOR="${BIKE_NODE_MAJOR:-22}"
MIN_NODE_VERSION="22.5.0"
NODE_DIST_BASE="${BIKE_NODE_DIST_BASE:-https://nodejs.org/dist}"

say() {
  printf '%s\n' "$*"
}

die() {
  say "错误：$*" >&2
  exit 1
}

usage() {
  cat <<EOF
用法：
  curl -fsSL ${RAW_BASE}/scripts/install-sync-server.sh | bash

可选环境变量：
  BIKE_VERSION=v1.4.2                 安装指定版本；默认 latest
  BIKE_INSTALL_DIR=/opt/bike-sync-server
  BIKE_SYNC_SERVICE_NAME=bike-sync-server
  BIKE_SYNC_SERVICE_USER=bike-sync
  BIKE_RAW_BASE=https://raw.githubusercontent.com/MoarLiu/Bike/main
  BIKE_NODE_VERSION=v22.x.y           指定内置 Node.js 版本；默认自动选择 Node 22 最新版
  BIKE_RUN_INSTALL=0                  只下载解压，不进入交互安装
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || "${1:-}" == "help" ]]; then
  usage
  exit 0
fi

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "未找到命令：$1"
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

node_version_ok() {
  local node_bin="$1"
  [[ -n "${node_bin}" && -x "${node_bin}" ]] || return 1
  "${node_bin}" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 5)) {
      process.exit(1);
    }
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
    say "下载内置 Node.js ${node_version}：${node_url}"
    curl -fL "${node_url}" -o "${archive_path}"
    run_or_sudo mkdir -p "${node_parent}"
    run_or_sudo tar -xJf "${archive_path}" -C "${node_parent}"
  fi

  NODE_BIN="${node_dir}/bin/node"
  node_version_ok "${NODE_BIN}" || die "内置 Node.js 不满足 ${MIN_NODE_VERSION}+：${NODE_BIN}"
  say "使用内置 Node.js：${NODE_BIN} ($("${NODE_BIN}" -v))"
}

ensure_node() {
  if node_version_ok "${NODE_BIN}"; then
    say "使用 Node.js：${NODE_BIN} ($(node_version_text "${NODE_BIN}"))"
    return
  fi

  if [[ -n "${NODE_BIN}" ]]; then
    say "当前 Node.js 是 $(node_version_text "${NODE_BIN}")，需要 ${MIN_NODE_VERSION} 或更新版本；将自动安装内置 Node.js ${NODE_MAJOR}.x。"
  else
    say "未找到 Node.js；将自动安装内置 Node.js ${NODE_MAJOR}.x。"
  fi
  install_node_runtime
}

systemd_available() {
  command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]
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

  say "创建 systemd 运行用户：${SERVICE_USER}"
  if command -v useradd >/dev/null 2>&1; then
    sudo_cmd useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
    return
  fi
  if command -v adduser >/dev/null 2>&1; then
    sudo_cmd adduser --system --home "${INSTALL_DIR}" --no-create-home --disabled-login "${SERVICE_USER}"
    return
  fi

  say "未找到 useradd/adduser，将在后续安装时手动选择 systemd 运行用户。"
}

need_command curl
need_command tar

TAG="${VERSION}"
if [[ "${TAG}" == "latest" ]]; then
  TAG="$(latest_tag)"
fi
[[ -n "${TAG}" ]] || die "无法获取最新 Release 版本。"
[[ "${TAG}" == v* ]] || TAG="v${TAG}"

VERSION_NUMBER="${TAG#v}"
ASSET_NAME="Bike-Web-${VERSION_NUMBER}-sync-server.tar.gz"
CHECKSUM_NAME="SHA256SUMS-${VERSION_NUMBER}.txt"
DOWNLOAD_URL="${GITHUB_BASE}/${REPO}/releases/download/${TAG}/${ASSET_NAME}"
CHECKSUM_URL="${GITHUB_BASE}/${REPO}/releases/download/${TAG}/${CHECKSUM_NAME}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

ARCHIVE_PATH="${TMP_DIR}/${ASSET_NAME}"
CHECKSUM_PATH="${TMP_DIR}/${CHECKSUM_NAME}"

say "下载 Bike Sync Server ${TAG}：${DOWNLOAD_URL}"
curl -fL "${DOWNLOAD_URL}" -o "${ARCHIVE_PATH}"
curl -fL "${CHECKSUM_URL}" -o "${CHECKSUM_PATH}"

EXPECTED_SHA="$(
  awk -v asset="${ASSET_NAME}" '$2 == asset || $2 == "web/" asset { print $1; exit }' "${CHECKSUM_PATH}"
)"
[[ -n "${EXPECTED_SHA}" ]] || die "校验文件中没有找到 ${ASSET_NAME}。"
sha256_check "${EXPECTED_SHA}" "${ARCHIVE_PATH}"

say "安装到：${INSTALL_DIR}"
run_or_sudo mkdir -p "${INSTALL_DIR}"
run_or_sudo tar -xzf "${ARCHIVE_PATH}" -C "${INSTALL_DIR}"
run_or_sudo chmod +x "${INSTALL_DIR}/scripts/setup-sync-server.sh"

if curl -fsSL "${RAW_BASE}/scripts/setup-sync-server.sh" -o "${TMP_DIR}/setup-sync-server.sh"; then
  say "刷新安装脚本：${RAW_BASE}/scripts/setup-sync-server.sh"
  run_or_sudo cp "${TMP_DIR}/setup-sync-server.sh" "${INSTALL_DIR}/scripts/setup-sync-server.sh"
  run_or_sudo chmod +x "${INSTALL_DIR}/scripts/setup-sync-server.sh"
fi

ensure_node
ensure_service_user

say "已解压 Bike Sync Server ${TAG}。"
if [[ "${RUN_INSTALL}" == "0" ]]; then
  cat <<EOF

跳过交互安装。后续可执行：
  cd ${INSTALL_DIR}
  NODE_BIN=${NODE_BIN} BIKE_SYNC_SERVICE_USER=${SERVICE_USER} ./scripts/setup-sync-server.sh install
EOF
  exit 0
fi

if [[ ! -r /dev/tty ]]; then
  die "当前环境没有可用 TTY，无法进入交互安装。可设置 BIKE_RUN_INSTALL=0 后手动执行安装脚本。"
fi

say "进入同步服务交互安装..."
sudo_cmd env \
  BIKE_SYNC_CONFIG="${INSTALL_DIR}/config/bike-sync.config.json" \
  BIKE_SYNC_SERVICE_NAME="${SERVICE_NAME}" \
  BIKE_SYNC_SERVICE_USER="${SERVICE_USER}" \
  NODE_BIN="${NODE_BIN}" \
  bash "${INSTALL_DIR}/scripts/setup-sync-server.sh" install < /dev/tty
