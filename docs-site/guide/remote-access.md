# Remote Access

Keygate Remote Gateway Access v1 gives you two supported ways to reach the operator UI and API from another machine without turning the gateway into a broadly exposed web service:

- Tailscale tailnet-only HTTPS on the gateway host
- managed SSH local-forward tunnels on operator machines

The recommended order is:

1. Tailscale for private day-to-day operator access
2. SSH tunnels when you already have SSH reachability
3. ngrok only when you explicitly need a public URL

## Default posture

Keygate now binds to `127.0.0.1` by default instead of relying on `localhost`.

That matters because:

- the local gateway is unambiguous
- CLI-generated URLs match the real bind target
- remote transports can forward the local service without broad host exposure

Default local URL:

```text
http://127.0.0.1:18790
```

## Protected operator surface

When remote access is enabled, Keygate token-gates the main operator surface:

- `/api/status`
- `/api/browser/*`
- `/api/uploads/*`
- `/ws`

Static assets remain public so the SPA can load and show a login form.

These routes keep their existing auth model:

- `/api/webhooks/*`
- `/api/gmail/push`
- `/api/plugins/*`

## Auth model

Keygate reuses `server.apiToken` as the shared remote operator token.

Flow:

1. A remote transport is started.
2. Keygate ensures `remote.authMode=token`.
3. If no token exists yet, Keygate generates one and prints it once.
4. The web app submits `Authorization: Bearer <token>` to `POST /api/auth/session`.
5. Keygate returns an HttpOnly session cookie.
6. The browser reconnects to `/ws` and starts using the protected API.

Logout clears the cookie through `DELETE /api/auth/session`.

## CLI summary

```bash
keygate remote tailscale start
keygate remote tailscale status
keygate remote tailscale url

keygate remote ssh config --host gateway.example.com --user ops --identity-file ~/.ssh/id_ed25519
keygate remote ssh start
keygate remote ssh status
keygate remote ssh url
```

## Which transport should you use?

### Tailscale

Use it when:

- both machines can join the same tailnet
- you want private HTTPS access
- you do not need a public URL

Read next: [/guide/tailscale-remote](/guide/tailscale-remote)

### SSH tunnel

Use it when:

- the gateway host is reachable over SSH
- you want the remote gateway to appear as a local port on the operator machine
- you already manage keys and host access

Read next: [/guide/ssh-tunnels](/guide/ssh-tunnels)

### ngrok

Use it when:

- you need public internet reachability
- you understand the larger exposure surface
- you have a concrete reason to publish the gateway instead of keeping it private

Read next: [/guide/ngrok](/guide/ngrok)

## Diagnostics

Use:

```bash
keygate status
keygate doctor
```

Both now include:

- bind host and port
- remote auth mode
- Tailscale remote state
- SSH tunnel profile completeness and runtime state

## Related reference pages

- [/reference/cli](/reference/cli)
- [/reference/configuration](/reference/configuration)
- [/reference/environment-variables](/reference/environment-variables)
- [/reference/security](/reference/security)
