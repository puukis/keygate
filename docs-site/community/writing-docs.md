# Writing Docs

This project treats documentation as part of the product.

## Documentation principles

1. **Actionable first** – include concrete commands and verification steps
2. **Single source of truth** – keep docs aligned with current behavior
3. **Operator clarity** – include failure modes and recovery steps
4. **No TODO docs** – avoid placeholders in published pages

## Style guide

- Use clear headings and short sections
- Prefer bullets/checklists over long dense paragraphs
- Include command blocks users can copy/paste
- Define terms on first use

## Required updates for behavior changes

If your PR changes any user-visible behavior, update docs in the same PR.

Examples:

- new CLI flags
- changed onboarding/auth flow
- modified security/approval behavior
- updated docker/deployment path
- changed sidebar/navigation behavior

## Docs review checklist

- [ ] links resolve
- [ ] commands were run at least once
- [ ] screenshots/snippets are current
- [ ] no contradictory statements across pages
- [ ] docs build passes locally (`pnpm docs:build`)

## Suggested workflow

```bash
pnpm docs:dev
# edit docs-site/**
pnpm docs:build
pnpm docs:preview
```

## Ownership

Everyone who changes behavior owns the corresponding docs change.
