# Sessions & Automations

Sessions are Keygate’s main isolation primitive. Automations attach to sessions instead of bypassing them.

## Session lifecycle

Key session operations:

- create
- rename
- switch
- delete
- reset
- compact

Use separate sessions for separate workflows:

- `web:release-triage`
- `discord:customer-success`
- `slack:ops-incident`

That keeps context narrow and makes automation routing predictable.

## Session controls

### Chat commands

```text
/new
/reset
/compact
/model
/status
```

### Web app

The **Sessions** tab lets you:

- create web sessions
- open existing sessions
- rename web sessions
- delete web sessions

### CLI / APIs

Session history and derived usage also surface through:

- `keygate status`
- `keygate usage`
- websocket `sessions_*` requests

## Automation surfaces

The **Automations** tab now includes three delivery mechanisms.

### Scheduler

Scheduler jobs need:

- target session
- cron expression
- prompt
- enabled state

### Webhooks

Webhook routes need:

- name
- target session
- prompt prefix
- shared secret
- enabled state

Inbound payloads are delivered as structured messages into the target session.

### Gmail

Gmail watches need:

- account
- target session
- optional label filters
- prompt prefix
- enabled state

Push notifications are deduped and then routed into the normal session pipeline.

## Design guidance

- keep one automation type per problem session when possible
- do not reuse a single session for unrelated cron jobs, webhooks, and Gmail watches
- use `/compact` on high-traffic automation sessions to keep prompt context stable
- prefer explicit label filters and prompt prefixes for Gmail/webhook sessions

## Debugging

If an automation appears idle:

1. verify the target session still exists
2. check that the automation is enabled
3. run `keygate status` or `keygate doctor`
4. inspect the **Debug** tab for the target session
5. use manual test paths:
   - scheduler: **Run now**
   - Gmail: `keygate gmail test <watchId>`
   - webhook: send a signed request to the route URL
