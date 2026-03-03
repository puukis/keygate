# Web App

The Keygate web app is your main operations cockpit.

## Sidebar navigation

- Chat
- Overview
- Channels
- Instances
- Sessions
- Automations

## Chat

Use Chat for live model interaction.

Capabilities:

- streaming responses
- attachment support
- read-only hints for mirrored channel sessions
- live stream activity timeline
- context usage meter

## Overview

Operational summary view for:

- connection state
- security mode
- current provider/model
- high-level runtime status

## Channels

Channel readiness snapshot and fast path to channel config in the settings drawer.

## Instances

Quick visibility into active runtime/session metrics and stream state.

## Sessions

Sessions tab is the canonical place to:

- create new sessions
- switch/open sessions
- rename web sessions
- delete web sessions

## Automations

Create scheduler jobs with:

- cron expression
- target session
- prompt instruction
- enabled/disabled state

Recommended pattern:

- Keep automations narrowly scoped to dedicated sessions
- Name sessions after project/goal for easier auditing

## Configuration drawer

Includes:

- Theme preferences
- Security mode toggles
- Provider/model selection and reasoning effort
- Plugin management (install, reload, enable/disable, config editing)
- Browser MCP management and policy settings
- Discord/Slack config
- Session controls
- Marketplace and memory utilities

## Plugins panel

The Plugins panel is now the operator surface for the runtime plugin system.

It supports:

- install from npm, git, local directories, or `.tgz`
- inspect plugin tools, routes, commands, and services
- enable, disable, reload, update, remove, or purge plugins
- validate plugin config
- schema-driven config forms for supported JSON Schema shapes
- raw JSON editing fallback for complex schemas
