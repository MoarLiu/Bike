#!/usr/bin/env bash

set -Eeuo pipefail

REPO="${BIKE_REPO:-MoarLiu/Bike}"
RAW_BASE="${BIKE_RAW_BASE:-https://raw.githubusercontent.com/${REPO}/${BIKE_BOOTSTRAP_REF:-v2.0.1}}"

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
warn "  curl -fsSL ${RAW_BASE}/scripts/install.sh -o bike-install.sh && bash bike-install.sh"

# Only use a sibling install.sh when this shim runs from a file. When piped
# (curl ... | bash), BASH_SOURCE is empty and dirname would point at the current
# directory, which could run an unrelated install.sh found there.
script_path="${BASH_SOURCE[0]:-}"
if [[ -n "${script_path}" && -f "${script_path}" ]]; then
  script_dir="$(cd "$(dirname "${script_path}")" && pwd)"
  if [[ -f "${script_dir}/install.sh" ]]; then
    exec bash "${script_dir}/install.sh" "${action}" "${@:2}"
  fi
fi

if command -v curl >/dev/null 2>&1; then
  temporary="$(mktemp)"
  trap 'rm -f "${temporary}"' EXIT
  curl -fsSL -o "${temporary}" "${RAW_BASE}/scripts/install.sh"
  bash "${temporary}" "${action}" "${@:2}"
  exit $?
fi

warn "错误：未找到 install.sh，且当前系统没有 curl。"
exit 1
