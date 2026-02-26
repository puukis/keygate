# GitHub Pages (Docs)

Keygate docs are deployed from `docs-site/` using GitHub Actions.

## Workflow

File: `.github/workflows/deploy-docs.yml`

Trigger:

- push to `main` for docs-related paths
- manual `workflow_dispatch`

Build command:

```bash
pnpm docs:build
```

Output directory:

- `docs-site/.vitepress/dist`

## Required repository settings

In GitHub repository settings:

1. Open **Settings → Pages**
2. Set source to **GitHub Actions**

## Local validation before push

```bash
pnpm docs:build
pnpm docs:preview
```

## URL format

With current base path configuration, site publishes at:

`https://<org-or-user>.github.io/keygate/`

## Common Pages failures

- workflow lacks `pages` permission
- Pages source not set to GitHub Actions
- broken links causing docs build to fail
- incorrect `base` path in VitePress config
