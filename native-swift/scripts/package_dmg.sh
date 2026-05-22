#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Local Outline Native"
PRODUCT_NAME="LocalOutlineNative"
VERSION="${VERSION:-0.1.0}"
DIST_DIR="$ROOT_DIR/dist"
RELEASE_DIR="$ROOT_DIR/release"
BUNDLE_PATH="$DIST_DIR/$APP_NAME.app"
INFO_PLIST="$ROOT_DIR/Sources/LocalOutlineNative/Resources/Info.plist"
ENTITLEMENTS="$ROOT_DIR/Sources/LocalOutlineNative/Resources/LocalOutlineNative.entitlements"
DMG_PATH="$RELEASE_DIR/Local-Outline-Native-$VERSION.dmg"
VOLUME_NAME="Local Outline Native $VERSION"

cd "$ROOT_DIR"

swift build --configuration release --product "$PRODUCT_NAME"
BUILD_DIR="$(swift build --configuration release --show-bin-path)"

rm -rf "$BUNDLE_PATH"
mkdir -p "$BUNDLE_PATH/Contents/MacOS" "$BUNDLE_PATH/Contents/Resources" "$RELEASE_DIR"
cp "$BUILD_DIR/$PRODUCT_NAME" "$BUNDLE_PATH/Contents/MacOS/$PRODUCT_NAME"
chmod +x "$BUNDLE_PATH/Contents/MacOS/$PRODUCT_NAME"
cp "$INFO_PLIST" "$BUNDLE_PATH/Contents/Info.plist"

if [[ -n "${CODE_SIGN_IDENTITY:-}" ]]; then
  codesign --force --deep --options runtime --entitlements "$ENTITLEMENTS" --sign "$CODE_SIGN_IDENTITY" "$BUNDLE_PATH"
else
  codesign --force --deep --entitlements "$ENTITLEMENTS" --sign - "$BUNDLE_PATH"
fi

rm -f "$DMG_PATH"
hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$BUNDLE_PATH" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

echo "$DMG_PATH"
