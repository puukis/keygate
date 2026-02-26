# Release Process

This page describes a practical GitHub release flow for Keygate, including macOS assets.

## Current automation

- npm publish workflow: `.github/workflows/publish-npm.yml`
- docs deploy workflow: `.github/workflows/deploy-docs.yml`

## macOS release assets

The release page layout should include:

- `Keygate-<version>.dmg`
- `Keygate-<version>.zip` (zipped `.app`)
- `Keygate-<version>.dSYM.zip` (debug symbols, optional but recommended)
- `Source code (zip)` and `Source code (tar.gz)` (added automatically by GitHub)

## Create a release from current `main`

You do not need a new commit if there are no code changes. You can tag the current `HEAD`.

```bash
cd ~/dev/projekte/aibot/keygate

VERSION="2026.2.26"
TAG="v${VERSION}"
OUT="packages/macos/dist"
BASE="Keygate-${VERSION}"

# Build artifacts
pnpm macos:app
pnpm macos:dmg

# Optional cleanup of temporary create-dmg leftovers from failed runs
rm -f "${OUT}"/rw.*.dmg

# Versioned release files
cp "${OUT}/Keygate-Installer.dmg" "${OUT}/${BASE}.dmg"
ditto -c -k --sequesterRsrc --keepParent "${OUT}/Keygate.app" "${OUT}/${BASE}.zip"
ditto -c -k --sequesterRsrc --keepParent "packages/macos/.xcodebuild-app/Build/Products/Release/Keygate.dSYM" "${OUT}/${BASE}.dSYM.zip"

# Push branch and tag
git push origin main
git tag -a "${TAG}" -m "Release ${TAG}"
git push origin "${TAG}"

# Create GitHub release with assets
gh auth status || gh auth login
gh release create "${TAG}" \
  "${OUT}/${BASE}.dmg" \
  "${OUT}/${BASE}.dSYM.zip" \
  "${OUT}/${BASE}.zip" \
  --title "Keygate ${VERSION}" \
  --notes "Keygate ${VERSION} release."
```

## Versioning guidance

- patch: bugfixes/internal improvements
- minor: backward-compatible features
- major: breaking behavior changes

## Post-release verification

- Download and open the DMG from the release page
- Verify drag-to-Applications install works
- Launch installed app and run onboarding/auth sanity check
- Open web UI and verify streaming response path
- Check docs pages and release links
