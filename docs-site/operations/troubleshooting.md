# Troubleshooting

Use this page as a runbook for common issues.

## Plugin runtime quick checks

- Run `keygate plugins doctor --json` to inspect duplicate ids, command collisions, config validation failures, and manifest diagnostics.
- If a plugin is `unhealthy`, inspect `lastError` in the web app Plugins panel or `keygate plugins info <id>`.
- If a plugin HTTP route returns `401`, verify `server.apiToken` and the `Authorization: Bearer <token>` header.
- If install/update fails, confirm the configured package manager can run `pack` and `install --ignore-scripts`.
- If hot reload does not trigger, verify `plugins.load.watch` and retry a manual `keygate plugins reload <id>`.

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

## 4b) Telegram is not responding

Checks:

- is `TELEGRAM_BOT_TOKEN` set and valid?
- is the runtime process started?
- is the sender blocked by DM or group policy?
- is the bot in a group with `groupMode=mention` and the message lacks a @mention?

Actions:

- run `keygate channels telegram status`
- start the runtime with `keygate channels telegram start`
- check `keygate pairing pending telegram` if DM policy is `pairing`
- approve pending pairing codes with `keygate pairing approve telegram <code>`
- restart with `keygate channels telegram restart` after config changes
- if you are running from a repo checkout, restart also refreshes the local `@puukis/core` build so Telegram does not keep using stale core logic
- if approval buttons spin and then appear stuck, update/restart the Telegram runtime and retry; current builds acknowledge the tap and clear the inline keyboard immediately
- if `/stop` seems delayed, update/restart the Telegram runtime; current builds cancel the active Telegram turn immediately instead of queueing the stop command behind it

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

## 7) Ngrok tunnel is not coming up

Checks:

- is `ngrok` installed locally?
- has ngrok been authenticated with an authtoken?
- is Keygate listening on `localhost:18790`?
- does `launchctl print gui/$(id -u)/com.keygate.ngrok` show a crash or restart loop?

Actions:

- run `keygate gateway open`
- run `keygate ngrok start`
- inspect `keygate ngrok status`
- tail `~/.keygate/ngrok.log`
- query `http://127.0.0.1:4040/api/tunnels` to verify the public URL

## Escalation template

When reporting issues, include:

- environment (OS, Node, pnpm)
- exact command used
- full error output
- expected vs actual behavior
- repro steps
