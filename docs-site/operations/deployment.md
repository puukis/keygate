# Deployment

This page covers practical deployment paths and verification.

## Deployment modes

- Local developer run (`pnpm dev`)
- Containerized runtime (Docker Compose)
- Service-managed runtime with reverse proxy

## Pre-deployment checklist

- [ ] dependencies install and build pass
- [ ] tests pass
- [ ] provider auth configured
- [ ] channel credentials configured (if used)
- [ ] security defaults reviewed
- [ ] backup/rollback plan defined

## Generic deployment flow

1. Build artifacts
2. Apply configuration/secrets
3. Start runtime
4. Verify health + websocket connectivity
5. Execute smoke tests

## Smoke test recommendations

- send message in web app
- validate streamed response
- run one tool call (safe)
- create/switch/rename session
- run one automation manually

## Rollback strategy

- Keep previous deploy artifact available
- Version your config and release notes
- Roll back quickly on auth/tooling regressions

## Post-deploy monitoring

- error logs
- model failure rates
- tool call failure rates
- channel disconnect events
