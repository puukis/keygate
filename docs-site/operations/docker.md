# Docker

Keygate includes Docker assets for containerized operation.

## Files

- `Dockerfile`
- `docker-compose.yml`
- `docker-entrypoint.sh`
- `docs/DOCKER.md` (detailed container notes)

## Quick start

```bash
docker compose up -d --build
```

## Verification checklist

- container is healthy
- web interface is reachable
- provider auth is valid
- a test session can send/receive messages

## Operational recommendations

- pin image tags in production
- mount persistent volumes for required state
- inject secrets via env/secret manager
- centralize logs for debugging/audit

## Updating containers

1. pull latest code/image
2. rebuild/restart compose stack
3. run smoke tests
4. monitor logs for regressions

## Failure scenarios

- startup crash due to missing env vars
- network conflicts / bound ports unavailable
- channel credentials invalid after rotate

When in doubt, inspect container logs first, then app-level logs.
