# Contributing

Thanks for contributing to Keygate. This guide defines a clean contributor workflow.

## Development setup

```bash
git clone https://github.com/puukis/keygate.git
cd keygate
pnpm install
pnpm dev
```

## Branching and PR flow

1. Create a focused branch
2. Keep changes scoped to one concern where possible
3. Add tests/docs for behavior changes
4. Open PR with clear context and verification steps

## Code quality expectations

- TypeScript changes should be explicit and readable
- Avoid broad, mixed-purpose commits
- Remove dead code and avoid TODO placeholders in shipped code
- Update docs when behavior changes

## Required checks before PR

```bash
pnpm build
pnpm test
pnpm docs:build
```

PR checklist:

- [ ] build passes
- [ ] tests pass
- [ ] docs updated
- [ ] migration notes added when needed
- [ ] security impact considered

## Writing good PR descriptions

Include:

- problem statement
- implementation summary
- risks/tradeoffs
- test evidence
- screenshots (if UI)

## Security and privacy responsibilities

- never commit tokens or secrets
- redact sensitive logs in issues/PRs
- flag risky behavior changes clearly
