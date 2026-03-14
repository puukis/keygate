# WhatsApp

Keygate can run a first-class WhatsApp channel using a linked-device session. This gives you direct-message automation and controlled group participation without exposing a public webhook endpoint.

## What the feature includes

- QR-based linked-device login
- Dedicated long-running WhatsApp runtime process
- DM policy controls (`pairing`, `open`, `closed`)
- Allow-from list for trusted phone numbers
- Group policy controls (`closed`, `selected`, `open`)
- Mention gating for group traffic
- Inbound media ingestion for images, audio, documents, and supported videos
- Inbound `👀` acknowledgement reactions on supported WhatsApp clients
- `composing` presence while Keygate is processing a message
- Outbound text replies plus browser screenshot follow-up images

## Login model

Keygate uses WhatsApp linked devices through Baileys. Your normal phone account remains the primary account. Keygate stores the linked session locally and reconnects from that stored auth state.

Important storage locations:

- Structured settings: `~/.keygate/config.json`
- Linked auth state: `~/.keygate/channels/whatsapp/auth/`
- Auth metadata: `~/.keygate/channels/whatsapp/meta.json`

Legacy `~/.config/keygate` installs are copied into `~/.keygate` on first run when the new root is missing. The old directory is left in place.

No new `.env` entry is required for WhatsApp login.

## CLI login

```bash
keygate channels whatsapp login
```

Optional flags:

```bash
keygate channels whatsapp login --force
keygate channels whatsapp login --timeout 180
```

Behavior:

1. Keygate starts a temporary WhatsApp socket.
2. It prints a QR code into the terminal.
3. You scan it in WhatsApp on your phone.
4. The temporary login socket exits after linking succeeds.

Use `--force` if you want to discard the old linked session before re-linking.

## Web UI login

Open the **Config** screen and use the **WhatsApp** section:

- Click **Generate Login QR**
- Scan the QR with WhatsApp
- Wait for the `whatsapp_login_result` event to confirm the link

If needed, click **Cancel QR** to stop the active login flow.

Only one login flow is active at a time. Starting a new one cancels the previous one.

## Runtime lifecycle

```bash
keygate channels whatsapp start
keygate channels whatsapp stop
keygate channels whatsapp restart
keygate channels whatsapp status
keygate channels whatsapp config
keygate channels whatsapp logout
```

`start` fails fast if the channel is not linked yet.

`logout` stops the runtime, removes the linked auth state, and clears any active login flow. It does not delete your structured WhatsApp policy settings.

When a WhatsApp message is accepted for processing, Keygate tries to add a `👀` reaction and emits `composing` presence while the assistant works. Both are best-effort and fail silently if the linked device or chat does not support them.

Fresh note-to-self messages from the linked number are supported as a test flow. Keygate still ignores stale replayed history, so reconnects do not reprocess old self-chat traffic.

## DM policy modes

- `pairing`: unknown senders create a pending approval request and stay blocked until approved
- `open`: any sender can start a DM session
- `closed`: only explicitly allowed senders can use DMs; all other WhatsApp DMs are ignored silently

Allow-from entries use comma-separated E.164 numbers or `*`.

Examples:

```text
+15551234567
+15551234567, +491701234567
*
```

## Pairing approvals

When a sender hits a `pairing` policy on WhatsApp, Keygate does not auto-reply into the chat. Instead it creates a pending request that the operator reviews locally.

List pending requests:

```bash
keygate pairing pending whatsapp
```

Approve the specific request you want:

```bash
keygate pairing approve whatsapp <code>
```

Operational notes:

- unknown WhatsApp contacts do not receive their pairing code automatically
- the runtime logs the pending code once so the operator can review it safely
- if you want zero-friction access for trusted numbers, use `allowFrom` or switch `dmPolicy` to `open`
- if you want allowlist-only behavior, use `dmPolicy: closed` with `allowFrom`

## Group policy

`groupMode` controls whether group traffic is eligible at all:

- `closed`: ignore all groups
- `selected`: only process groups explicitly listed in `groups`
- `open`: allow all groups, then apply mention rules

Group IDs use the Keygate format:

```text
group:<id>
```

Examples:

```text
group:120363025870000000
group:120363025870000000|mention
group:120363025870000000|no-mention
```

Meaning:

- plain `group:<id>`: use the default mention rule
- `|mention`: always require a mention/reply
- `|no-mention`: process even without a mention

## Mention detection

If mention gating is enabled, Keygate processes a group message when either of these is true:

- the linked account is explicitly mentioned
- the message is a reply to a recent Keygate message in that group

If mention gating is required and neither condition is met, the message is ignored silently.

## Media handling

Inbound media support:

- images
- voice notes and audio
- documents
- videos within the configured size ceiling

Accepted media is stored in the normal Keygate workspace attachment area and attached to the normalized session message.

Oversized or unsupported media is rejected with a short WhatsApp reply instead of crashing the runtime.

## Config changes and restarts

WhatsApp policy changes are stored immediately, but the runtime reads the config on start. Restart the runtime after changing settings:

```bash
keygate channels whatsapp restart
```

## Common failure modes

- Login QR expires before scanning: restart the login flow
- Runtime says the channel is not linked: run `keygate channels whatsapp login`
- Runtime exits after disconnect: inspect logs for a fatal logout and re-link if needed
- Group traffic is ignored: verify `groupMode`, explicit group keys, and mention rules
- Pairing seems silent: this is expected on WhatsApp; inspect `keygate pairing pending whatsapp` and approve the exact channel-specific code with `whatsapp`
- New unknown DMs get no response: this is expected when `dmPolicy` is `closed` and the sender is not in `allowFrom`

## Privacy and security

- Do not commit `~/.keygate/channels/whatsapp/auth/`
- Treat the linked auth directory like a credential store
- Use `pairing` or `closed` for DMs unless you intentionally want public access
- Keep `groupRequireMentionDefault` enabled if you use `groupMode=open`
