#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Bike Native"
PRODUCT_NAME="BikeNative"
VERSION="${VERSION:-$(node -p "require('$ROOT_DIR/../package.json').version" 2>/dev/null || echo "1.1.2")}"
DIST_DIR="$ROOT_DIR/dist"
RELEASE_DIR="$ROOT_DIR/release"
BUNDLE_PATH="$DIST_DIR/$APP_NAME.app"
DMG_STAGING_DIR="$DIST_DIR/dmg-staging"
INFO_PLIST="$ROOT_DIR/Sources/BikeNative/Resources/Info.plist"
ENTITLEMENTS="$ROOT_DIR/Sources/BikeNative/Resources/BikeNative.entitlements"
APP_ICON="$ROOT_DIR/Sources/BikeNative/Resources/AppIcon.icns"
DMG_PATH="$RELEASE_DIR/Bike-Native-$VERSION.dmg"
VOLUME_NAME="Bike Native $VERSION"

cd "$ROOT_DIR"

rm -rf "$DIST_DIR" "$RELEASE_DIR"
mkdir -p "$DIST_DIR" "$RELEASE_DIR"

swift build --configuration release --product "$PRODUCT_NAME"
BUILD_DIR="$(swift build --configuration release --show-bin-path)"

mkdir -p "$BUNDLE_PATH/Contents/MacOS" "$BUNDLE_PATH/Contents/Resources"
cp "$BUILD_DIR/$PRODUCT_NAME" "$BUNDLE_PATH/Contents/MacOS/$PRODUCT_NAME"
chmod +x "$BUNDLE_PATH/Contents/MacOS/$PRODUCT_NAME"
cp "$INFO_PLIST" "$BUNDLE_PATH/Contents/Info.plist"
cp "$APP_ICON" "$BUNDLE_PATH/Contents/Resources/AppIcon.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$BUNDLE_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$BUNDLE_PATH/Contents/Info.plist"
strip -x "$BUNDLE_PATH/Contents/MacOS/$PRODUCT_NAME" 2>/dev/null || true

if [[ -n "${CODE_SIGN_IDENTITY:-}" ]]; then
  codesign --force --deep --options runtime --entitlements "$ENTITLEMENTS" --sign "$CODE_SIGN_IDENTITY" "$BUNDLE_PATH"
else
  codesign --force --deep --entitlements "$ENTITLEMENTS" --sign - "$BUNDLE_PATH"
fi

mkdir -p "$DMG_STAGING_DIR"
cp -R "$BUNDLE_PATH" "$DMG_STAGING_DIR/"
ln -s /Applications "$DMG_STAGING_DIR/Applications"
find "$DMG_STAGING_DIR" -name ".DS_Store" -delete

rm -f "$DMG_PATH"
hdiutil create \
  -volname "$VOLUME_NAME" \
  -srcfolder "$DMG_STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

echo "$DMG_PATH"
