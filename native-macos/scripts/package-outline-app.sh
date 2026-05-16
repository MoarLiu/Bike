#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICON_SOURCE="${1:-/Users/crazyjal/Library/Application Support/CleanShot/media/media_SGNNhJ8hjH/CleanShot 2026-05-16 at 23.03.12@2x.png}"
RELEASE_DIR="$ROOT_DIR/release"
APP_PATH="$RELEASE_DIR/Outline.app"
CONTENTS_DIR="$APP_PATH/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
EXECUTABLE_SOURCE="$ROOT_DIR/.build/release/LocalOutlineNative"
EXECUTABLE_TARGET="$MACOS_DIR/Outline"
ICONSET_DIR="$ROOT_DIR/.build/OutlineIcon.iconset"
ICON_SOURCE_SQUARE="$ROOT_DIR/.build/OutlineIconSource.png"

if [[ ! -f "$ICON_SOURCE" ]]; then
  echo "找不到图标文件：$ICON_SOURCE" >&2
  exit 1
fi

swift build -c release --package-path "$ROOT_DIR"

rm -rf "$APP_PATH" "$ICONSET_DIR" "$ROOT_DIR/.build/OutlineIcon.icns"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$ICONSET_DIR"

sips --cropToHeightWidth 72 72 "$ICON_SOURCE" --out "$ICON_SOURCE_SQUARE" >/dev/null

make_icon() {
  local size="$1"
  local name="$2"
  sips -z "$size" "$size" "$ICON_SOURCE_SQUARE" --out "$ICONSET_DIR/$name" >/dev/null
}

make_icon 16 "icon_16x16.png"
make_icon 32 "icon_16x16@2x.png"
make_icon 32 "icon_32x32.png"
make_icon 64 "icon_32x32@2x.png"
make_icon 128 "icon_128x128.png"
make_icon 256 "icon_128x128@2x.png"
make_icon 256 "icon_256x256.png"
make_icon 512 "icon_256x256@2x.png"
make_icon 512 "icon_512x512.png"
make_icon 1024 "icon_512x512@2x.png"

iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/OutlineIcon.icns"

cp "$EXECUTABLE_SOURCE" "$EXECUTABLE_TARGET"
chmod +x "$EXECUTABLE_TARGET"

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>Outline</string>
  <key>CFBundleExecutable</key>
  <string>Outline</string>
  <key>CFBundleIconFile</key>
  <string>OutlineIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.localoutline.native</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Outline</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP_PATH" >/dev/null
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

ditto -c -k --norsrc --keepParent "$APP_PATH" "$RELEASE_DIR/Outline-arm64.zip"

echo "$APP_PATH"
echo "$RELEASE_DIR/Outline-arm64.zip"
