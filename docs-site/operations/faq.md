# FAQ

## Do I need to push to test docs?
No. Use `pnpm docs:dev` locally, then `pnpm docs:build` + `pnpm docs:preview`.

## Where is the docs source?
In `docs-site/`.

## How do docs get deployed?
GitHub Actions via `.github/workflows/deploy-docs.yml` to GitHub Pages.

## Why does my docs build fail on links?
VitePress treats dead links as build errors by default. Fix path/case mismatches.

## Where should I configure provider and model?
From the web app settings drawer; persist config via runtime config files/env.

## Why is a session read-only?
It mirrors a non-web channel conversation. Reply in the source channel.

## Why are my tool calls asking for approval?
You're in a protected flow (safe mode/policy constraints) and action requires confirmation.

## What should I do before enabling spicy mode?
Understand blast radius, test in isolated sessions, and keep approval discipline.

## How do I debug scheduler jobs?
Check enabled state, cron syntax, target session, then use “Run now” and inspect logs.

## Can I run Keygate fully in Docker?
Yes, via Dockerfile/compose flow. Validate auth, channels, and websocket behavior after startup.
