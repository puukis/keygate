#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$PACKAGE_DIR/../.." && pwd)"

APP_NAME="${APP_NAME:-Keygate}"
SCHEME="${SCHEME:-Keygate}"
CONFIGURATION="${CONFIGURATION:-Release}"
DESTINATION="${DESTINATION:-platform=macOS}"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-$PACKAGE_DIR/.xcodebuild-app}"
OUTPUT_DIR="${OUTPUT_DIR:-$PACKAGE_DIR/dist}"
APP_BUNDLE_PATH="$OUTPUT_DIR/$APP_NAME.app"
PRODUCTS_DIR="$DERIVED_DATA_PATH/Build/Products/$CONFIGURATION"
BINARY_PATH="$PRODUCTS_DIR/$APP_NAME"
ICONSET_SOURCE="$PACKAGE_DIR/Sources/Keygate/Resources/Assets.xcassets/AppIcon.appiconset"

BUNDLE_IDENTIFIER="${BUNDLE_IDENTIFIER:-dev.keygate.app}"
ADHOC_SIGN="${ADHOC_SIGN:-1}"

log() {
  printf "==> %s\n" "$*"
}

fail() {
  printf "error: %s\n" "$*" >&2
  exit 1
}

if [[ -z "${DISPLAY_VERSION:-}" ]]; then
  if command -v node >/dev/null 2>&1 && [[ -f "$REPO_DIR/package.json" ]]; then
    DISPLAY_VERSION="$(node -e 'const fs=require("node:fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(String(j.version||"0.1.0"));' "$REPO_DIR/package.json" 2>/dev/null || true)"
  fi
fi
DISPLAY_VERSION="${DISPLAY_VERSION:-0.1.0}"
BUILD_VERSION="${BUILD_VERSION:-$(printf '%s' "$DISPLAY_VERSION" | tr -cd '0-9' | sed 's/^$/1/')}"

copy_icon() {
  local source="$1"
  local target="$2"
  local iconset_dir="$3"

  if [[ -f "$ICONSET_SOURCE/$source" ]]; then
    cp "$ICONSET_SOURCE/$source" "$iconset_dir/$target"
  fi
}

log "Building $SCHEME ($CONFIGURATION) with xcodebuild"
(
  cd "$PACKAGE_DIR"
  xcodebuild \
    -scheme "$SCHEME" \
    -configuration "$CONFIGURATION" \
    -destination "$DESTINATION" \
    -derivedDataPath "$DERIVED_DATA_PATH" \
    build
)

[[ -x "$BINARY_PATH" ]] || fail "Expected executable at $BINARY_PATH"

RESOURCE_BUNDLE_PATH="$(find "$PRODUCTS_DIR" -maxdepth 1 -type d -name "*_${APP_NAME}.bundle" -print -quit || true)"
[[ -n "$RESOURCE_BUNDLE_PATH" ]] || fail "Expected SwiftPM resource bundle in $PRODUCTS_DIR"

log "Assembling app bundle at $APP_BUNDLE_PATH"
rm -rf "$APP_BUNDLE_PATH"
mkdir -p \
  "$APP_BUNDLE_PATH/Contents/MacOS" \
  "$APP_BUNDLE_PATH/Contents/Resources" \
  "$APP_BUNDLE_PATH/Contents/Frameworks"

cp "$BINARY_PATH" "$APP_BUNDLE_PATH/Contents/MacOS/$APP_NAME"
chmod +x "$APP_BUNDLE_PATH/Contents/MacOS/$APP_NAME"

ditto "$RESOURCE_BUNDLE_PATH" "$APP_BUNDLE_PATH/Contents/Resources/$(basename "$RESOURCE_BUNDLE_PATH")"

framework_count=0
shopt -s nullglob
for framework in "$PRODUCTS_DIR"/*.framework; do
  framework_count=$((framework_count + 1))
  ditto "$framework" "$APP_BUNDLE_PATH/Contents/Frameworks/$(basename "$framework")"
done
shopt -u nullglob

if [[ "$framework_count" -eq 0 ]]; then
  fail "No frameworks found in $PRODUCTS_DIR"
fi

# SwiftPM executable products use @executable_path/../lib by default.
ln -sfn "Frameworks" "$APP_BUNDLE_PATH/Contents/lib"

if command -v iconutil >/dev/null 2>&1 && [[ -d "$ICONSET_SOURCE" ]]; then
  icon_tmp_dir="$(mktemp -d "$PACKAGE_DIR/.iconset.XXXXXX")"
  trap 'rm -rf "$icon_tmp_dir"' EXIT

  iconset_dir="$icon_tmp_dir/$APP_NAME.iconset"
  mkdir -p "$iconset_dir"

  copy_icon "appicon_16.png" "icon_16x16.png" "$iconset_dir"
  copy_icon "appicon_16@2x.png" "icon_16x16@2x.png" "$iconset_dir"
  copy_icon "appicon_32.png" "icon_32x32.png" "$iconset_dir"
  copy_icon "appicon_32@2x.png" "icon_32x32@2x.png" "$iconset_dir"
  copy_icon "appicon_128.png" "icon_128x128.png" "$iconset_dir"
  copy_icon "appicon_128@2x.png" "icon_128x128@2x.png" "$iconset_dir"
  copy_icon "appicon_256.png" "icon_256x256.png" "$iconset_dir"
  copy_icon "appicon_256@2x.png" "icon_256x256@2x.png" "$iconset_dir"
  copy_icon "appicon_512.png" "icon_512x512.png" "$iconset_dir"
  copy_icon "appicon_512@2x.png" "icon_512x512@2x.png" "$iconset_dir"

  if compgen -G "$iconset_dir/*.png" >/dev/null; then
    log "Generating ${APP_NAME}.icns"
    iconutil -c icns "$iconset_dir" -o "$APP_BUNDLE_PATH/Contents/Resources/$APP_NAME.icns"
  fi

  rm -rf "$icon_tmp_dir"
  trap - EXIT
fi

cat >"$APP_BUNDLE_PATH/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>${APP_NAME}.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_IDENTIFIER}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${DISPLAY_VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${BUILD_VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
EOF

if [[ "$ADHOC_SIGN" == "1" ]]; then
  log "Applying ad-hoc code signature"
  codesign --force --deep --sign - "$APP_BUNDLE_PATH"
fi

log "App bundle ready:"
printf '%s\n' "$APP_BUNDLE_PATH"
