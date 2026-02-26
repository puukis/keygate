# CI/CD Workflows

Keygate uses GitHub Actions for validation, docs publishing, and package release flows.

## Workflow inventory

- `ci.yml` – unified CI for build/test/docs/docker-check
- `build.yml` – build only
- `test.yml` – test only
- `docs-check.yml` – docs build check
- `docker-check.yml` – docker validation/build
- `deploy-docs.yml` – publish docs to GitHub Pages
- `publish-npm.yml` – publish npm packages
- `package-smoke.yml` – scheduled/manual package smoke
- `docker-smoke.yml` – scheduled/manual compose smoke

## Why keep both unified + split workflows

- unified CI gives one high-level health signal
- split workflows isolate failures and rerun cost

## Recommended branch protection

Require these checks on PRs:

- CI
- Build
- Test
- Docs Check
- Docker Check

## Local pre-flight before PR

```bash
pnpm install
pnpm build
pnpm test
pnpm docs:build
docker compose config
docker build -t keygate-local-check .
```

## Failure triage

- Build fail → compile/type or bundling issue
- Test fail → behavior regression
- Docs fail → markdown/dead links/config issue
- Docker fail → compose/build/runtime packaging issue
