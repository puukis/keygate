# Release Process

This page describes a practical release flow for Keygate.

## Current automation

- npm publish workflow: `.github/workflows/publish-npm.yml`
- docs deploy workflow: `.github/workflows/deploy-docs.yml`

## Recommended release sequence

1. Merge tested changes to `main`
2. Ensure CI and docs build are green
3. Confirm package versions are correct
4. Publish packages (workflow/manual policy)
5. Tag release
6. Update changelog/release notes

## Versioning guidance

- patch: bugfixes/internal improvements
- minor: backward-compatible features
- major: breaking behavior changes

## Release notes template

- Highlights
- Breaking changes
- Migration steps
- Fixes
- Known issues

## Post-release verification

- install/upgrade test from npm
- quick onboarding/auth sanity check
- web UI smoke test
- channel integration sanity check
- docs links/pages valid
