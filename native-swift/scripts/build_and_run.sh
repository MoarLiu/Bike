#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Bike Native"
PRODUCT_NAME="BikeNative"
DIST_DIR="$ROOT_DIR/dist"
BUNDLE_PATH="$DIST_DIR/$APP_NAME.app"
INFO_PLIST="$ROOT_DIR/Sources/BikeNative/Resources/Info.plist"
APP_ICON="$ROOT_DIR/Sources/BikeNative/Resources/AppIcon.icns"
LOGS=false
VERIFY=false

usage() {
  cat <<EOF
Usage: scripts/build_and_run.sh [--logs] [--verify]

Builds the SwiftPM macOS app, stages dist/$APP_NAME.app, and launches it.

Options:
  --logs      Stream unified logs for the app process after launch.
  --verify    Confirm the app process is running after launch.
  -h, --help  Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --logs)
      LOGS=true
      shift
      ;;
    --verify)
      VERIFY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$ROOT_DIR"

if pgrep -x "$PRODUCT_NAME" >/dev/null 2>&1; then
  pkill -x "$PRODUCT_NAME" || true
  sleep 0.4
fi

swift build --configuration debug --product "$PRODUCT_NAME"
BUILD_DIR="$(swift build --configuration debug --show-bin-path)"

rm -rf "$BUNDLE_PATH"
mkdir -p "$BUNDLE_PATH/Contents/MacOS" "$BUNDLE_PATH/Contents/Resources"
cp "$BUILD_DIR/$PRODUCT_NAME" "$BUNDLE_PATH/Contents/MacOS/$PRODUCT_NAME"
chmod +x "$BUNDLE_PATH/Contents/MacOS/$PRODUCT_NAME"
cp "$INFO_PLIST" "$BUNDLE_PATH/Contents/Info.plist"
cp "$APP_ICON" "$BUNDLE_PATH/Contents/Resources/AppIcon.icns"

/usr/bin/open -n "$BUNDLE_PATH"

if [[ "$VERIFY" == "true" ]]; then
  sleep 1
  if pgrep -x "$PRODUCT_NAME" >/dev/null 2>&1; then
    echo "$APP_NAME launched."
  else
    echo "$APP_NAME did not start." >&2
    exit 1
  fi
fi

if [[ "$LOGS" == "true" ]]; then
  /usr/bin/log stream --style compact --predicate "process == \"$PRODUCT_NAME\""
fi
