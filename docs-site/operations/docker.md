# Docker

Docker appears in Keygate in two different roles:

1. as a deployment target for the gateway itself
2. as the safe-mode sandbox backend for filesystem, shell, and code-execution tools

This page covers both.

## Deployment files

- `Dockerfile`
- `docker-compose.yml`
- `docker-entrypoint.sh`
- `docs/DOCKER.md`

## Running Keygate itself in Docker

Quick start:

```bash
docker compose up -d --build
```

Use this when you want the gateway process itself to run inside containers.

## Docker as the safe-mode sandbox backend

Independent of whether the gateway itself is containerized, safe mode uses Docker for tool isolation.

Relevant config:

```json
{
  "security": {
    "sandbox": {
      "backend": "docker",
      "scope": "session",
      "image": "keygate-sandbox:latest",
      "networkAccess": false,
      "degradeWithoutDocker": true
    }
  }
}
```

Operational commands:

```bash
keygate sandbox list
keygate sandbox explain --scope <scopeKey>
keygate sandbox recreate --scope <scopeKey>
keygate doctor
keygate status
```

## Verification checklist

- Docker daemon is running
- `keygate doctor` reports healthy sandbox status
- `keygate sandbox list` shows expected runtimes after a safe-mode tool call
- the web **Instances** tab shows the same sandbox inventory
- a safe-mode filesystem or shell tool call succeeds

## Degraded behavior

If Docker is unavailable:

- Keygate still starts
- safe-mode sandboxed tools fail fast instead of silently falling back to host execution
- `/status`, the web app, and `keygate doctor` all show degraded sandbox health

This is intentional. Missing Docker is treated as a security posture problem, not a transparent fallback.

## Operational recommendations

- pin the sandbox image in controlled environments
- keep network access disabled unless a workflow explicitly requires it
- choose `scope: session` for reuse and `scope: agent` for stricter delegated isolation
- mount persistent volumes for deployment containers, but do not over-mount host paths into the sandbox image
- centralize Docker logs when debugging production incidents

## Updating

1. update the deployment image or compose stack
2. update the sandbox image if your safe-mode runtime changed
3. restart the gateway
4. run `keygate doctor`
5. run one safe-mode tool smoke test

## Failure scenarios

- Docker daemon not running
- sandbox image missing or outdated
- container labels/scope mismatches after manual Docker edits
- production container healthy but safe-mode sandbox unhealthy

When Docker-related behavior looks wrong, inspect both:

- deployment container logs
- `keygate sandbox explain` / `keygate doctor` output
