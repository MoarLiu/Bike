#!/usr/bin/env bash

set -Eeuo pipefail

REPO="${BIKE_REPO:-MoarLiu/Bike}"
RAW_BASE="${BIKE_RAW_BASE:-https://raw.githubusercontent.com/${REPO}/main}"

warn() {
  printf '%s\n' "$*" >&2
}

if [[ -z "${BIKE_INSTALL_DIR:-}" ]]; then
  export BIKE_INSTALL_DIR="/opt/bike-sync-server"
fi

action="${1:-menu}"
case "${action}" in
  install) action="install-sync" ;;
  update) action="update-sync" ;;
esac

warn "提示：install-sync-server.sh 已更名为 install.sh，建议改用："
warn "  curl -fsSL ${RAW_BASE}/scripts/install.sh | bash"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${script_dir}/install.sh" ]]; then
  exec bash "${script_dir}/install.sh" "${action}" "${@:2}"
fi

if command -v curl >/dev/null 2>&1; then
  exec bash -c 'raw="$1"; shift; curl -fsSL "$raw/scripts/install.sh" | bash -s -- "$@"' bash "${RAW_BASE}" "${action}" "${@:2}"
fi

warn "错误：未找到 install.sh，且当前系统没有 curl。"
exit 1
