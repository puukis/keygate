# Keygate macOS App Bundle

`packages/macos` contains the SwiftUI desktop app source.  
Swift Package builds this target as an executable, so use the script below to assemble a proper `.app` bundle.

## Build `Keygate.app`

```bash
pnpm macos:app
```

Output:

`packages/macos/dist/Keygate.app`

## Build Styled Installer DMG

```bash
pnpm macos:dmg
```

Output:

`packages/macos/dist/Keygate-Installer.dmg`

This produces the drag-to-`Applications` installer layout with a custom background.

## Useful Overrides

All overrides are optional environment variables:

- `BUNDLE_IDENTIFIER` (default: `dev.keygate.app`)
- `DISPLAY_VERSION` (default: repo `package.json` version, fallback `0.1.0`)
- `BUILD_VERSION` (default: digits from `DISPLAY_VERSION`)
- `ADHOC_SIGN` (default: `1`; set `0` to skip ad-hoc signing)
- `OUTPUT_DIR` (default: `packages/macos/dist`)
- `DERIVED_DATA_PATH` (default: `packages/macos/.xcodebuild-app`)
- `DESTINATION` (default: `platform=macOS`)

Example:

```bash
ADHOC_SIGN=0 BUNDLE_IDENTIFIER=dev.keygate.desktop pnpm macos:app
```

DMG overrides (optional):

- `DMG_PATH` (default: `packages/macos/dist/Keygate-Installer.dmg`)
- `BACKGROUND_PATH` (default: `packages/macos/assets/dmg/installer-background.png`)
- `WINDOW_WIDTH`, `WINDOW_HEIGHT` (defaults: `660`, `420`)
- `APP_ICON_X`, `APP_ICON_Y` (defaults: `170`, `186`)
- `DROP_LINK_X`, `DROP_LINK_Y` (defaults: `470`, `186`)
