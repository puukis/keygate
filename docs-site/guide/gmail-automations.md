# Gmail Automations

Keygate can watch Gmail mailboxes and deliver matching events into normal session threads.

It can also send one-off emails through the authenticated Gmail account.

## What Gmail automation includes

- Google OAuth login
- persisted Gmail accounts
- multiple watch definitions per install
- label-based routing
- automatic watch renewal
- Pub/Sub push intake
- duplicate notification suppression
- delivery into target sessions through the normal gateway pipeline

## Required configuration

Add Gmail defaults in `~/.keygate/config.json` or equivalent config root:

```json
{
  "gmail": {
    "clientId": "YOUR_GOOGLE_OAUTH_CLIENT_ID",
    "defaults": {
      "pubsubTopic": "projects/your-project/topics/keygate-gmail",
      "pushBaseUrl": "https://keygate.example.com",
      "pushPathSecret": "replace-me",
      "targetSessionId": "web:ops-inbox",
      "labelIds": ["INBOX"],
      "promptPrefix": "[GMAIL WATCH EVENT]",
      "watchRenewalMinutes": 1320
    }
  }
}
```

## CLI workflow

### Login

```bash
keygate gmail login
```

Headless environments:

```bash
keygate gmail login --headless
```

### Inspect state

```bash
keygate gmail list
keygate gmail list --json
```

### Send an email

```bash
keygate gmail send \
  --to recipient@example.com \
  --subject "Status update" \
  --body "Deployment finished successfully."
```

Optional flags:

- `--account <id|email>` sends from a specific authenticated Gmail account when multiple accounts are configured
- `--reply-to <messageId>` adds `In-Reply-To` and `References` headers for threaded replies
- `--thread <threadId>` asks Gmail to attach the outgoing message to an existing Gmail thread

What the result means:

- Keygate reports success when Gmail accepts the message and returns a Gmail message id
- that confirms the mail was handed to Gmail and placed in the sender's `SENT` mailbox
- it does not guarantee the destination provider placed it in the recipient inbox
- if the recipient does not see the email, check spam/junk on the destination mailbox and watch for later delivery-status notifications in the sender mailbox

Composer behavior:

- Keygate now sends multipart email with both plain-text and HTML parts
- pure ASCII bodies are sent as normal 7bit MIME parts instead of base64 blobs, which makes outgoing mail look closer to a message composed in Gmail itself
- single-line CLI bodies that contain literal `\\n` sequences are normalized into real line breaks before send
- this matches Gmail compose behavior more closely and avoids mails arriving as one long line with backslash characters
- agent-driven sends prefer the native Gmail send tool first and only fall back to shell-based `keygate gmail send` when needed

### Create a watch

```bash
keygate gmail watch \
  --account you@example.com \
  --session web:ops \
  --labels INBOX,IMPORTANT \
  --prompt-prefix "[GMAIL WATCH EVENT]"
```

### Update / test / delete / renew

```bash
keygate gmail update <watchId> --labels INBOX
keygate gmail test <watchId>
keygate gmail delete <watchId>
keygate gmail renew
keygate gmail renew --account you@example.com
```

## Web app workflow

Open **Automations**:

- **Webhooks** manages signed JSON routes
- **Gmail** lists connected Gmail accounts and configured watches
- create or update a watch by choosing:
  - account
  - target session
  - label filter list
  - prompt prefix
  - enabled state

The app does not complete OAuth login itself. Use `keygate gmail login`, then refresh the Automations page.

## Push endpoint

Gmail Pub/Sub push notifications are received on:

```text
/api/gmail/push
```

If `gmail.defaults.pushPathSecret` is configured, include it in the push URL:

```text
https://keygate.example.com/api/gmail/push?secret=...
```

Keygate validates the Google OIDC bearer token when present and rejects unauthorized pushes.

## Delivery format

When a watch matches, Keygate sends a structured message into the target session containing:

- account email
- watch id
- message id / thread id
- label ids
- subject
- sender
- date
- snippet

That means Gmail-triggered work enters the same session history, tool flow, and usage accounting as any other message source.

## Operational notes

- Gmail `watch` is renewed automatically before expiration.
- The doctor command reports account count, watch count, and renewal pressure.
- When push notifications are duplicated, Keygate drops them using its Gmail dedupe store.
- Outgoing email is composed as RFC-compliant UTF-8 MIME so non-ASCII subjects and bodies are encoded safely for delivery.
