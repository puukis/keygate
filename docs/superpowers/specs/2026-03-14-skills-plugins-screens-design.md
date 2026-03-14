# Skills & Plugins Screens — Design Spec

**Date:** 2026-03-14
**Status:** Approved
**Platforms:** Web App (`packages/web`) · macOS App (`packages/macos`)

---

## Overview

Extract Skills and Plugins management out of the Config screen's scroll-to-section pattern and give each its own dedicated screen. Enhance both with advanced features modelled on Claude Code's plugin TUI and Claude.ai's skills/connectors UI. Apply the Keygate Obsidian Premium design system throughout.

---

## Goals

1. Skills and Plugins each have a dedicated top-level screen in the web app
2. Skills and Plugins each have a dedicated tab in macOS Settings (replacing Integrations)
3. Plugins screen handles both npm plugins and MCP servers in sub-tabs
4. Skills screen includes a built-in marketplace/browse mode (installed ↔ browse toggle)
5. Consistent shared detail panel pattern across both screens
6. macOS and web stay in visual/functional parity where native constraints allow

---

## Architecture Decision

**Approach C — Two Dedicated Screens + Shared Detail Panel**

- Skills and Plugins are separate screens/tabs with maximum real estate per feature
- MCP Servers live inside Plugins as a sub-tab (conceptually a plugin type)
- A shared detail/config panel component handles config editing for both screens
- Avoids duplicating the env-var editor, config form, and action buttons

---

## Web App

### Routing & Navigation

- Skills: sidebar item `Skills` under the Agent group navigates to `activeScreen = 'skills'`
- Plugins: sidebar item `Plugins` under the Agent group navigates to `activeScreen = 'plugins'`
- Both are **direct navigation targets**, not scroll offsets into Config
- Config screen retains Appearance, Security, Model, MCP Browser, Memory sections — removes the Skills and Plugins sections

### Skills Screen

**URL/state:** `activeScreen = 'skills'`

#### Layout
```
┌─ Screen Header ─────────────────────────────────────────────┐
│  Skills                                    / skills          │
├─ Toolbar ───────────────────────────────────────────────────┤
│  [Search...]  [Installed | Browse]  [all][global][ws][plugin]│
├─ Stats Bar ─────────────────────────────────────────────────┤
│  ● 12 loaded  ● 9 eligible  ● 3 ineligible  ● 4 disabled   │
├─ Content Area ──────────────────────────────────────────────┤
│  ┌─ Card Grid (2-col) ───────────┐ ┌─ Detail Panel ────────┐│
│  │ [skill-card] [skill-card]     │ │ name · badges         ││
│  │ [skill-card] [skill-card]     │ │ description           ││
│  │ ...                           │ │ [Disable][Reload][Rm] ││
│  └───────────────────────────────┘ │ Status rows           ││
│                                    │ Invoke chip           ││
│                                    │ Env editor            ││
│                                    │ [Browse marketplace →]││
│                                    └───────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

#### Installed Tab

**Stats bar** — four counters sourced from `SkillRuntimeSnapshot`:
- Loaded (total `snapshot.loaded.length`)
- Eligible (`snapshot.eligible.length`)
- Ineligible (loaded minus eligible, enabled only)
- Disabled (entries with `enabled: false`)

**Filter pills** — filter by `sourceType`: all / global / workspace / plugin / bundled / extra

**Skill card** — displays:
- Skill name (monospace)
- Description (2-line clamp)
- Source badge (`workspace` green · `global` gold · `plugin` purple · `bundled` amber)
- Eligibility dot (green = eligible · red = ineligible · grey = disabled)
- Enable/disable toggle (calls existing enable/disable RPC)
- Selected state: gold top-border accent + subtle gold background tint

**Detail panel** (visible when a card is selected):
- Name + source badge + version badge + eligibility badge
- Description
- Action buttons: Disable / Reload / Remove
- Status rows: Eligible, User invocable, Scope, Source plugin, Location (path)
- Invoke chip: `/name [arg-hint]` in monospace with gold command color
- Env var editor: key/value rows, each editable inline, "+ Add variable" row
- "Browse skill marketplace →" footer link (switches to Browse tab)

#### Browse Tab

- Search input + Search button + "Featured" reset button
- Category filter chips (sourced from marketplace tags)
- Results grid: card per entry showing name (⭐ if featured), version, description, author, download count, tag chips
- Click → detail view: full description, homepage link, scope selector (workspace / global), Install button, install status feedback

### Plugins Screen

**URL/state:** `activeScreen = 'plugins'`

#### Sub-tabs

Two sub-tabs in a tab bar below the screen header:

| Sub-tab | Badge |
|---|---|
| npm Plugins | count of installed npm plugins |
| MCP Servers | count of configured MCP servers |

#### npm Plugins Sub-tab

**Toolbar:**
- Install bar: text input (placeholder: `npm spec, git URL, or local path...`) + scope selector (`global / workspace`) + Install button
- Search field (filter installed list)
- Refresh button

**Category chips** (filter installed list): all / code intelligence / integrations / workflows / productivity / output styles / security

**Plugin list** (replaces card grid — rows work better for plugins with more metadata):
- Icon (emoji or first-letter avatar), name (monospace), version, status badge (active/disabled/unhealthy/available), surface chips (tools count, commands count, routes count), enable/disable toggle
- Selected state: gold border + subtle tint

**Detail panel:**
- Icon, name, badges (status + scope + version)
- Description
- Action buttons: Disable / Reload / Update / Remove / Purge
- Status section: status, scope, version, entry point
- Exposed surfaces section: tool chips (gold), command chips (green), route chips (blue) — color-coded
- Configuration section: schema-driven form when `configSchema` present, raw JSON editor fallback; Validate + Save Config buttons
- Environment section: inline key/value editor, "+ Add variable"

#### MCP Servers Sub-tab

**Add-server bar:**
- URL/command input + transport selector (http / sse / stdio) + scope selector (local / project / user) + Add Server button (gold primary)

**Server list:**
- Live status dot (green/red/grey with glow on connected), name (monospace), URL/command (truncated), transport badge (http blue · sse purple · stdio amber), scope badge, enable/disable toggle
- Selected state: gold border + subtle tint

**Detail panel:**
- Status dot + name
- Connection badges: transport + scope + auth status
- Description (if server provides one)
- Action buttons: Disconnect / Reconnect / Remove
- Connection section: transport, command/URL, scope, auth method
- Tools section: chip list of exposed tool names
- Environment section: inline key/value editor

---

## macOS App

### Tab Structure Change

**Before:** General · Appearance · LLM · Security · Browser · Runtime · Integrations
**After:** General · Appearance · LLM · Security · Browser · Runtime · Skills · Plugins

- Integrations tab is **removed**
- Discord, Slack, Device Node sections **move into Runtime tab**
- Runtime tab gets a new "Integrations" sub-section at the bottom
- Window frame: expand from `520 × 420` to `560 × 500` — Skills and Plugins tabs need the height; other tabs are unaffected (SwiftUI will scroll or clip)

### Skills Tab — SwiftUI Structure

```swift
SkillsSettingsTab()
    .tabItem { Label("Skills", systemImage: "sparkles") }
```

**Data source note:** `gateway.skillsConfig` (`SkillsConfig` model, `Messages.swift`) currently only contains `loadedCount` and `eligibleCount`. The Skills tab needs `ineligibleCount`, `disabledCount`, and a `skills: [SkillEntry]` array (name, sourceType, eligible, enabled, invokeAs, location). Extend `SkillsConfig` in `Messages.swift` and the corresponding server-side status payload to include these fields. This is a minor data model extension — the server already has all this data in `SkillRuntimeSnapshot`.

**Sections:**

1. **Stats section** — custom `HStack` with four `VStack` cells (Loaded/Eligible/Ineligible/Disabled), each showing a large monospaced number and label. Sourced from `gateway.skillsConfig.loadedCount`, `.eligibleCount`, `.ineligibleCount`, `.disabledCount`.

2. **Filter section** — `Picker("Scope", ...)` with `.segmented` style (All / Global / Workspace / Plugin) + `Toggle("Show ineligible", ...)` + search `TextField`.

3. **Installed Skills section** — `List` with `ForEach` over filtered `gateway.skillsRuntime.entries`. Each row:
   - Status dot (`Circle().fill(...)`)
   - Skill name in `.monospaced()`
   - Source badge chip
   - `Toggle(isOn: ...)` bound to `enabled` state, calls enable/disable via gateway

4. **Detail section** — conditionally shown when `selectedSkill != nil`:
   - `LabeledContent` rows: Eligible, User invocable, Scope, Source, Location
   - Invoke command in monospaced text
   - "Edit Env Vars…" button → presents a `Sheet` with key/value editor
   - `HStack` of action buttons: Reload, Remove

5. **Load directory section**:
   - "Load Skills Directory…" button → `NSOpenPanel` for folder selection
   - `Toggle("Watch for changes", ...)` bound to `skills.load.watch`
   - "Browse in Web App" link → opens web app at `/skills` URL

### Plugins Tab — SwiftUI Structure

```swift
PluginsSettingsTab()
    .tabItem { Label("Plugins", systemImage: "puzzlepiece.extension") }
```

**Sub-section picker:**
```swift
Picker("", selection: $pluginSection) {
    Text("npm Plugins").tag(PluginSection.npm)
    Text("MCP Servers").tag(PluginSection.mcp)
}
.pickerStyle(.segmented)
```

**npm Plugins sections** (when `pluginSection == .npm`):

1. **Install section** — text field + scope picker (Global/Workspace) + Install button + Refresh button
2. **Installed Plugins section** — `List/ForEach` over `gateway.plugins`. Each row: name (monospaced), version, status badge, `Toggle`.
3. **Detail section** — conditionally shown when `selectedPlugin != nil`: status, scope, tools/commands/routes list, "Edit Config…" sheet button, "Edit Env…" sheet button, Reload/Update/Remove buttons.

**MCP Servers sections** (when `pluginSection == .mcp`):

1. **Add Server section** — URL/command text field + transport picker (http/sse/stdio) + scope picker (Local/Project/User) + Add Server button
2. **Connected Servers section** — `List/ForEach` over `gateway.mcpServers`. Each row: status dot, name (monospaced), URL (truncated), transport/scope chips, `Toggle`.
3. **Detail section** — conditionally shown when `selectedServer != nil`: connection info rows, tools count, auth status, "Edit Env…" sheet button, Reconnect/Remove buttons.

---

## Shared Components

### SkillDetailPanel (Web)
A React component used by the Skills screen:
- Props: `skill: SkillRuntimeEntry`, `onAction: (action: SkillAction) => void`
- Renders: status rows, invoke chip, env-var editor, action buttons
- Used in both Installed and Browse modes (Browse shows Install instead of action buttons)

### PluginDetailPanel (Web)
A React component used by the Plugins screen for both npm plugins and MCP servers:
- Props: `item: PluginInfoView | McpServerView`, `type: 'plugin' | 'mcp'`, `onAction`
- Renders appropriate sections based on `type`
- Shares the EnvVarEditor and ConfigSchemaForm sub-components

### EnvVarEditor (Web + macOS)
- Web: inline rows in detail panel — key input + value input + delete icon, "+ Add variable" button
- macOS: presented as a `Sheet` — `List` of key/value `TextField` pairs + Add/Remove row buttons

### ConfigSchemaForm (Web)
- Renders a form from `pluginInfo.configSchema` (JSON Schema)
- Falls back to raw JSON `TextEditor` when schema is absent
- Validate button (calls validate RPC), Save Config button

---

## Design Tokens (Keygate Obsidian Premium)

All new components use these CSS variables — no hardcoded colors:

| Token | Value |
|---|---|
| `--bg-primary` | `#030303` |
| `--surface-elevated` | `#111111` |
| `--accent` | `#c8a96e` |
| `--accent-soft` | `rgba(200,169,110,0.10)` |
| `--accent-border` | `rgba(200,169,110,0.25)` |
| `--border` | `rgba(255,255,255,0.055)` |
| `--success` | `#5ca882` |
| `--danger` | `#c0645a` |
| `--warning` | `#d4944a` |
| `--font-sans` | `DM Sans` |
| `--font-display` | `Cormorant Garamond` |
| `--font-mono` | `JetBrains Mono` |

---

## Files to Create / Modify

### Web App (`packages/web/src/`)

**New files:**
- `components/SkillsScreen.tsx` — full Skills screen
- `components/SkillsScreen.css`
- `components/PluginsScreen.tsx` — full Plugins screen
- `components/PluginsScreen.css`
- `components/SkillDetailPanel.tsx` — shared detail panel for skills
- `components/PluginDetailPanel.tsx` — shared detail panel for plugins/MCP
- `components/EnvVarEditor.tsx` — reusable inline env var editor
- `components/McpServersPanel.tsx` — MCP servers sub-tab

**Modified files:**
- `App.tsx` — add `'skills'` and `'plugins'` to `activeScreen` union type; add routing cases; remove scroll-to-section logic for marketplace/plugins; keep existing `PluginsPanel` and `MarketplacePanel` used in Config as-is until replaced
- `components/SessionSidebar.tsx` — change `open_config_marketplace` / `open_config_plugins` actions to `navigate_skills` / `navigate_plugins` direct navigation
- `components/SessionSidebar.test.tsx` — update action ID assertions from `open_config_marketplace` / `open_config_plugins` to `navigate_skills` / `navigate_plugins`
- `App.css` — add screen-level layout classes

### macOS App (`packages/macos/Sources/Keygate/Views/Settings/`)

**Modified files:**
- `SettingsRootView.swift` — remove `IntegrationsSettingsTab`, add `SkillsSettingsTab` and `PluginsSettingsTab` tabs; move Discord/Slack/Node into `RuntimeSettingsTab`; update frame to `560 × 500`
- `Models/Messages.swift` — extend `SkillsConfig` struct with `ineligibleCount: Int?`, `disabledCount: Int?`, and `skills: [SkillEntry]?`; add `SkillEntry` struct (name, sourceType, eligible, enabled, invokeAs, location)

**New files:**
- `SkillsSettingsTab.swift`
- `PluginsSettingsTab.swift`
- `EnvVarEditorSheet.swift` — reusable sheet for editing env vars
- `ConfigEditorSheet.swift` — reusable sheet for editing plugin config JSON

---

## Out of Scope

- Backend/API changes — all RPCs for skill and plugin management already exist
- Changing the skill runtime or plugin loader
- Adding new skill types or plugin sources
- Mobile / WebChat UI

---

## Success Criteria

1. Clicking "Skills" in web sidebar opens the dedicated Skills screen (not Config)
2. Clicking "Plugins" in web sidebar opens the dedicated Plugins screen (not Config)
3. Skills screen Installed tab lists all skills with correct source badges and eligibility dots
4. Skills screen Browse tab can search and install skills from the marketplace
5. Plugins screen npm tab can install, enable/disable, and remove plugins
6. Plugins screen MCP tab can add, enable/disable, and remove MCP servers
7. macOS Settings has Skills tab and Plugins tab replacing Integrations
8. macOS Runtime tab includes Discord/Slack/Device Node sections from removed Integrations tab
9. All new UI uses Keygate Obsidian Premium design tokens (no hardcoded blues or generic fonts)
10. Playwright tests pass for web screens: navigation, toggle, detail panel open, env editor
