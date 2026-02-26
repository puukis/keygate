#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="${DIST_DIR:-$PACKAGE_DIR/dist}"

APP_NAME="${APP_NAME:-Keygate}"
APP_BUNDLE_PATH="${APP_BUNDLE_PATH:-$DIST_DIR/$APP_NAME.app}"
DMG_PATH="${DMG_PATH:-$DIST_DIR/${APP_NAME}-Installer.dmg}"
VOLNAME="${VOLNAME:-$APP_NAME Installer}"

BACKGROUND_PATH="${BACKGROUND_PATH:-$PACKAGE_DIR/assets/dmg/installer-background.png}"
WINDOW_WIDTH="${WINDOW_WIDTH:-660}"
WINDOW_HEIGHT="${WINDOW_HEIGHT:-420}"
WINDOW_POS_X="${WINDOW_POS_X:-200}"
WINDOW_POS_Y="${WINDOW_POS_Y:-120}"
ICON_SIZE="${ICON_SIZE:-128}"
TEXT_SIZE="${TEXT_SIZE:-13}"
APP_ICON_X="${APP_ICON_X:-170}"
APP_ICON_Y="${APP_ICON_Y:-186}"
DROP_LINK_X="${DROP_LINK_X:-470}"
DROP_LINK_Y="${DROP_LINK_Y:-186}"

log() {
  printf "==> %s\n" "$*"
}

fail() {
  printf "error: %s\n" "$*" >&2
  exit 1
}

if ! command -v create-dmg >/dev/null 2>&1; then
  fail "create-dmg is required. Install with: brew install create-dmg"
fi

if ! [[ "$TEXT_SIZE" =~ ^[0-9]+$ ]] || (( TEXT_SIZE < 10 || TEXT_SIZE > 16 )); then
  fail "TEXT_SIZE must be an integer between 10 and 16 (Finder limitation)"
fi

if [[ ! -d "$APP_BUNDLE_PATH" ]]; then
  log "App bundle missing, building it first"
  bash "$SCRIPT_DIR/build-app.sh"
fi

[[ -d "$APP_BUNDLE_PATH" ]] || fail "Expected app bundle at $APP_BUNDLE_PATH"
[[ -f "$BACKGROUND_PATH" ]] || fail "Expected DMG background at $BACKGROUND_PATH"

mkdir -p "$DIST_DIR"

staging_dir="$(mktemp -d "$PACKAGE_DIR/.dmg-staging.XXXXXX")"
cleanup() {
  rm -rf "$staging_dir"
}
trap cleanup EXIT

log "Preparing staging folder"
ditto "$APP_BUNDLE_PATH" "$staging_dir/$APP_NAME.app"

if [[ -f "$DMG_PATH" ]]; then
  log "Removing old DMG"
  rm -f "$DMG_PATH"
fi

create_dmg_args=(
  --volname "$VOLNAME"
  --window-pos "$WINDOW_POS_X" "$WINDOW_POS_Y"
  --window-size "$WINDOW_WIDTH" "$WINDOW_HEIGHT"
  --background "$BACKGROUND_PATH"
  --text-size "$TEXT_SIZE"
  --icon-size "$ICON_SIZE"
  --icon "$APP_NAME.app" "$APP_ICON_X" "$APP_ICON_Y"
  --hide-extension "$APP_NAME.app"
  --app-drop-link "$DROP_LINK_X" "$DROP_LINK_Y"
  --format UDZO
)

volume_icon_path="$APP_BUNDLE_PATH/Contents/Resources/$APP_NAME.icns"
if [[ -f "$volume_icon_path" ]]; then
  create_dmg_args+=(--volicon "$volume_icon_path")
fi

log "Creating styled DMG"
create-dmg "${create_dmg_args[@]}" "$DMG_PATH" "$staging_dir"

log "DMG ready:"
printf '%s\n' "$DMG_PATH"
