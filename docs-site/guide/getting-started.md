# Getting Started

Keygate is a personal AI gateway that lets you run an assistant across web, terminal, and chat channels with a unified runtime and tool layer.

This page is the fastest path from zero to a working local instance.

## Who this documentation is for

- **Users** who want to run Keygate locally
- **Contributors** who want to build features or fix bugs
- **Operators** who need repeatable deployment and troubleshooting procedures

## What Keygate includes

- Session-based AI chat with streaming output
- Tool execution with confirmation flow for sensitive actions
- Multi-provider model support (including OpenAI Codex flow)
- Optional external channels (Discord, Slack)
- Browser MCP integration and policy controls
- Scheduler/automation workflows tied to sessions

## 10-minute quickstart

```bash
git clone https://github.com/puukis/keygate.git
cd keygate
pnpm install
pnpm dev
```

Then open the web app and complete onboarding.

## Suggested first-run checklist

1. Confirm Node.js + pnpm versions
2. Start app and verify websocket connection
3. Send one test prompt
4. Run one safe tool action
5. Create a second session and rename it
6. Open Automations and create a disabled cron job
7. Verify settings drawer (model/provider, security, browser)

## Where to go next

- Setup details: [Installation](/guide/installation)
- Runtime design: [Architecture](/guide/architecture)
- UI controls: [Web App](/guide/web-app)
- Safe operations: [Security](/reference/security)
