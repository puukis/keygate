# Troubleshooting

Use this page as a runbook for common issues.

## 1) Web app says disconnected

Checks:

- Is backend process running?
- Is websocket reachable from browser?
- Any reverse proxy misconfiguration?

Actions:

- restart runtime
- inspect browser devtools network tab
- inspect server logs around startup

## 2) Model request fails

Checks:

- provider auth state
- selected model validity
- quota/permission issues

Actions:

- re-run auth login
- switch to known-good model
- verify provider-side account status

## 3) Tool call failed

Checks:

- required approval denied or missing
- path/command invalid
- environment permission mismatch

Actions:

- inspect live activity details
- replay with narrower prompt
- verify runtime mode and guardrails

## 4) Channel integration unstable

Checks:

- token validity/scopes
- event delivery/websocket/webhook health
- rate limiting

Actions:

- rotate tokens
- verify app config in Discord/Slack portals
- reduce message burst rate

## 4a) WhatsApp is not receiving messages

Checks:

- is the linked-device session still present?
- does `keygate channels whatsapp status` show linked auth?
- is the runtime process started?
- are DM/group policies blocking the sender?

Actions:

- run `keygate channels whatsapp status`
- re-link with `keygate channels whatsapp login` if auth was logged out
- restart with `keygate channels whatsapp restart`
- verify `groupMode`, explicit `group:<id>` keys, and mention rules

## 5) Scheduler job not running

Checks:

- enabled state
- cron expression syntax
- target session exists

Actions:

- use “Run now” test
- inspect session and tool logs
- recreate job if metadata is stale

## 6) Docs build fails

Checks:

- dead links in markdown
- VitePress config syntax
- dependency install state

Actions:

- run `pnpm docs:build`
- fix reported dead links
- verify `base` path for GitHub Pages

## Escalation template

When reporting issues, include:

- environment (OS, Node, pnpm)
- exact command used
- full error output
- expected vs actual behavior
- repro steps
