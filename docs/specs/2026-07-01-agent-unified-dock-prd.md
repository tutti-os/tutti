# PRD: Agent Unified Dock

## 1. Summary

This PRD defines the first iteration of the Agent dock upgrade.

The product direction is to aggregate the existing Codex and Claude Code dock
entries behind one Agent dock entry, while keeping provider-specific Agent GUI
nodes available. The first iteration supports only native local CLI targets for
Codex and Claude Code. Future iterations can add user-defined agent targets,
including skill-backed personas, without changing the dock model again.

The default rollout mode remains the current split dock experience. The
`agentDockLayout` preference is persisted through the existing desktop
preference system, but the first rollout exposes the switch from the Developer
settings panel so the unified dock can remain controlled while it is validated.

## 2. Goals

- Keep the legacy split dock as the default experience.
- Add an AB setting that lets users switch between split and unified Agent dock
  layouts.
- Introduce a lightweight Agent Target data model with default system targets
  for Codex and Claude Code.
- In unified mode, show one Agent dock entry that groups all Agent GUI nodes.
- Preserve provider-specific multi-window behavior. Codex and Claude Code nodes
  may still be opened at the same time.
- Add first-iteration conversation-list filters: All, Codex, Claude Code.
- Keep composer provider selection independent from the top filter.
- Allow first-iteration Agent Target ids to be used as the preferred launch and
  runtime attribution authority for system local CLI targets.
- Move AgentGUI `@` mention discovery for agents out of the `workspace-app`
  provider and into a dedicated `agent-target` provider.
- Preserve historical sessions, historical workbench node state, and legacy
  dock entry launch compatibility.

## 3. Non-Goals

- Do not build user-defined agent personas in this iteration.
- Do not add skill configuration, prompt templates, MCP configuration, model
  defaults, or permission defaults to the Agent Target table.
- Do not migrate or rewrite historical sessions.
- Do not force all providers into one singleton Agent GUI window.
- Do not make the top filter change the composer provider.
- Do not design the full target-aware composer UX in this iteration. The first
  iteration may still persist and use the selected system Agent Target id for
  launch, runtime attribution, and target-scoped composer option caching.
- Do not remove legacy dock entry identifiers.
- Do not preserve special open/resolve behavior for historical
  `mention://workspace-app/agent-codex?...` or
  `mention://workspace-app/agent-claude-code?...` mentions. They may remain as
  inert historical mention chips or unknown workspace-app mentions.
- Do not remove provider convenience CLI commands such as `tutti codex start`
  or `tutti claude start`; the breaking change applies only to `@` mention
  discovery identity.

## 4. Terminology

- **Provider**: the real execution provider, such as `codex` or `claude-code`.
- **Agent Target**: a selectable launch target shown in Agent UI. First
  iteration targets map one-to-one to native local CLI providers.
- **Launch ref**: a controlled provider-facing JSON union that describes the
  target identity needed for launch. It is not a general extension bag.
- **External `@` provider**: a provider id exposed through the rich-text
  mention palette and `window.tuttiExternal.at.query`, such as `workspace-app`
  or `agent-target`.
- **Agent Target `@` provider**: the `agent-target` mention provider that
  returns Agent Target rows for agent discovery. It is separate from the
  `workspace-app` provider.
- **Split dock**: the current behavior where Codex and Claude Code have
  separate dock entries.
- **Unified dock**: the new behavior where one Agent dock entry groups
  provider-specific Agent GUI nodes.

## 5. Agent Target Data Model

Create a durable Agent Target registry in `services/tuttid`.

### 5.1 Table Shape

```sql
agent_targets

id                  text primary key
provider            text not null
launch_ref_json     text not null
name                text not null
icon_key            text
enabled             integer not null default 1
source              text not null
sort_order          integer not null default 0
created_at_ms       integer not null
updated_at_ms       integer not null
```

### 5.2 Field Semantics

- `id`: stable Agent Target identity used by UI state, preferences, and future
  launch attribution.
- `provider`: real execution provider. For this iteration, supported values are
  `codex` and `claude-code`.
- `launch_ref_json`: controlled launch-target reference. It describes only the
  provider target identity needed for launch.
- `name`: display name.
- `icon_key`: stable icon lookup key. It is presentation metadata, not launch
  logic.
- `enabled`: whether the target should be selectable.
- `source`: ownership of the target record. First iteration values are
  `system` and `user`.
- `sort_order`: deterministic display order.
- `created_at_ms` / `updated_at_ms`: durable timestamps.

### 5.3 Launch Ref Schema

`launch_ref_json` must be validated as a controlled union. It must not become a
free-form configuration blob.

First iteration:

```ts
type AgentTargetLaunchRef = {
  type: "local_cli";
  provider: "codex" | "claude-code";
};
```

Rules:

- `launch_ref_json.type` must be a known union discriminator.
- `launch_ref_json.provider` must match the table `provider`.
- UI display must not read labels, icons, or sort behavior from
  `launch_ref_json`.
- Composer settings must not be stored in `launch_ref_json`.
- Skill, prompt, MCP, model, and permission configuration must not be stored in
  `launch_ref_json`.

Future extension example:

```ts
type AgentTargetLaunchRef =
  | { type: "local_cli"; provider: "codex" | "claude-code" }
  | { type: "agent_profile"; provider: string; profile_id: string };
```

The profile payload itself should live in a separate profile/config table.

### 5.4 Default Rows

Initialize two system targets during repository/workspace setup:

```json
{
  "id": "local:codex",
  "provider": "codex",
  "launch_ref_json": {
    "type": "local_cli",
    "provider": "codex"
  },
  "name": "Codex",
  "icon_key": "codex",
  "enabled": true,
  "source": "system",
  "sort_order": 10
}
```

```json
{
  "id": "local:claude-code",
  "provider": "claude-code",
  "launch_ref_json": {
    "type": "local_cli",
    "provider": "claude-code"
  },
  "name": "Claude Code",
  "icon_key": "claude-code",
  "enabled": true,
  "source": "system",
  "sort_order": 20
}
```

System rows must not be deleted by normal user actions. They may be disabled or
hidden only through explicit product behavior.

## 6. AB Setting

Add a setting through the existing desktop preference path.

```ts
type AgentDockLayout = "legacySplit" | "unified";
```

Default:

```text
legacySplit
```

Behavior:

- `legacySplit`: keep current separate Codex and Claude Code dock entries.
- `unified`: show one Agent dock entry that groups all Agent GUI nodes.
- Switching the setting must not migrate sessions or rewrite workbench state.
- The setting is a presentation preference. It does not affect provider
  execution, session storage, or Agent Target records.
- First rollout UI placement is the Developer settings panel. This is a rollout
  control, not a separate preference system; the stored preference contract and
  event payload remain the normal desktop preference path.

## 7. Dock Behavior

### 7.1 Legacy Split Mode

Keep current behavior:

- Codex has its own dock entry.
- Claude Code has its own dock entry.
- Existing node matching and launch behavior remain compatible.

### 7.2 Unified Mode

Unified mode changes dock presentation only:

- Render one Agent dock entry.
- The Agent dock entry matches all Agent GUI nodes, regardless of provider.
- Multiple provider-specific Agent GUI nodes can be open at the same time.
- The dock popup/minimized preview groups matching Agent GUI nodes under the
  single Agent entry.

Dock click default behavior:

```text
if matching Agent GUI nodes exist
  -> use existing workbench grouped dock behavior
else
  -> create an Agent GUI node for the first available target
```

Default target resolution:

```text
desktopPreferences.defaultAgentProvider if currently available
-> first enabled Agent Target by sort_order whose provider is available
-> Codex fallback
```

Availability should consider provider probe status when available. `enabled`
alone is not enough to prove the local CLI can run on the current machine.

## 8. Launch Compatibility

Legacy identifiers remain valid:

- `agent-gui` continues to mean Codex when no provider is otherwise specified.
- `agent-gui:codex` continues to mean Codex.
- `agent-gui:claude-code` continues to mean Claude Code.

Launch resolution rules:

- If the launch payload includes a provider, use that provider.
- If the launch payload includes a session id, resolve the session provider and
  open/focus the corresponding provider-specific Agent GUI node.
- If the launch comes from a legacy provider dock id, preserve that provider.
- In unified mode, the resulting node is still grouped under the single Agent
  dock entry.

Historical workbench state must continue to render:

- Existing Codex nodes remain Codex nodes.
- Existing Claude Code nodes remain Claude Code nodes.
- Switching AB modes must not delete, rewrite, or merge existing nodes.

## 9. Conversation Filtering

Unified Agent GUI adds a top filter with exactly these first-iteration options:

- All
- Codex
- Claude Code

Rules:

- The filter affects only the conversation list.
- The filter does not change the composer provider.
- The filter does not change the default target for the next launch.
- Historical sessions are filtered by `session.provider`.
- If future sessions include `agent_target_id`, filtering must still fall back
  to `session.provider` so old sessions remain visible.

## 10. Composer Behavior

Full target-aware composer UX is out of scope for this iteration, but the
implementation is allowed to carry the first-iteration system Agent Target id
through node state, session creation, runtime session projection, and
composer-options caching.

Rules:

- Top filter and composer provider are independent.
- Selecting Codex or Claude Code in the filter must not mutate composer state.
- Existing composer defaults by provider remain valid.
- When `agentTargetId` is present for a new session, the daemon derives the real
  provider and provider-facing runtime ref from the stored Agent Target
  `launch_ref_json`.
- If both `agentTargetId` and `provider` are present, the provider must match
  the daemon-derived launch ref provider.
- Desktop and AgentGUI should not let an opaque UI `providerTargetRef` override
  the daemon-derived runtime ref for target-backed local CLI launches.
- Broader target-aware composer UX, such as user-defined personas, target
  editing, model defaults, permission defaults, prompt templates, skill
  configuration, or MCP configuration, will be designed separately.

## 11. AgentGUI `@` Mention Palette Migration

This iteration treats Agent Target discovery as its own `@` mention category.
Agents should no longer be modeled as pseudo workspace apps in the AgentGUI
composer or in the external app `@` query bridge.

### 11.1 Current Problem

The existing `@` application list exposes Codex and Claude Code as
workspace-app candidates, using app ids such as `agent-codex` and
`agent-claude-code`. That was useful when the goal was to make agent entry
points visible through the same application surface, but it does not scale to
many user-defined agent targets. Future custom agents would pollute the Apps
tab and force app-id-specific filtering logic.

### 11.2 Target Model

Add a dedicated external `@` provider:

```ts
type TuttiExternalAtProviderId =
  | "file"
  | "workspace-issue"
  | "workspace-app"
  | "agent-session"
  | "agent-generated-file"
  | "agent-target";
```

Rules:

- `workspace-app` returns real workspace app candidates only. It must not
  return Agent Target rows or agent pseudo apps.
- `agent-target` returns Agent Target candidates. First iteration candidates are
  `local:codex` and `local:claude-code`.
- AgentGUI renders an Agents tab backed by `agent-target`.
- AgentGUI renders an Apps tab backed by `workspace-app`, excluding agent
  targets.
- When `window.tuttiExternal.at.query` omits `providers`, the default provider
  set includes `agent-target`, so external apps using default `@` search can
  still discover agents.
- When an external app explicitly queries only `providers: ["workspace-app"]`,
  it receives only apps. This is an intentional breaking change.

### 11.3 Mention Identity

New Agent Target mentions use Agent Target identity rather than workspace app
identity.

```text
mention://agent-target/local:codex
mention://agent-target/local:claude-code
```

The inserted mention should carry:

- provider id: `agent-target`
- item id / entity id: the Agent Target id, such as `local:codex`
- scope: omitted for first-iteration local Agent Targets unless future
  multi-workspace or shared-target behavior requires extra context
- presentation: display name, icon, and provider metadata derived from the
  Agent Target and provider catalog

The current workspace is still available to the query/insert pipeline through
host context such as AgentGUI props or `window.tuttiExternal.at.query`; it is
not part of the canonical `agent-target` mention URI.

Historical pseudo-app mention ids are not forward-compatible launch authority:

- `mention://workspace-app/agent-codex?...`
- `mention://workspace-app/agent-claude-code?...`

The product accepts breaking these as active open/resolve targets. They may
continue to render as historical tokens when already present in transcripts or
drafts, but new AgentGUI and external `@` queries must not create them.

### 11.4 Launch And Command Semantics

Selecting an `agent-target` mention is a reference to an agent launch target,
not a workspace app launch.

Rules:

- A new session launch should prefer `agentTargetId` as the durable authority.
- The daemon still derives the real provider and provider-facing runtime ref
  from `agent_targets.launch_ref_json`.
- The external `@` provider must not expose `launch_ref_json` as a free-form
  invocation payload.
- Provider convenience commands remain valid, including `tutti codex start` and
  `tutti claude start`.
- Future custom agents should use generic target-first launch paths, such as an
  Agent Activity create-session request with `agentTargetId`, rather than
  generating one app id or one CLI shortcut per target.

### 11.5 Implementation Boundaries

- `services/tuttid` owns Agent Target storage and the daemon API/CLI surfaces
  needed to list Agent Target candidates.
- `apps/desktop` owns the concrete `agent-target` rich-text provider wiring,
  provider availability filtering, icon mapping, and
  `window.tuttiExternal.at.query` bridge integration.
- `@tutti-os/agent-gui` owns palette grouping, the Agents tab presentation, and
  insertion of `agent-target` mentions.
- `@tutti-os/workspace-external-core` owns the public provider id contract.
- The `workspace-app` mention provider must remove agent pseudo-app special
  cases instead of adding another app-category filter.

## 12. API And Runtime Notes

The implementation should keep the existing Agent Activity boundaries:

```text
tuttid durable data and provider launch
  -> desktop AgentActivityAdapter / WorkspaceAgentActivityService
  -> AgentActivityRuntime
  -> AgentGUI UI and local view state
```

Ownership:

- `services/tuttid` owns Agent Target storage, validation, default rows, and
  provider-facing launch ref validation. It also owns target-first session
  launch resolution when `agentTargetId` is supplied.
- `apps/desktop` owns concrete preference wiring, provider availability probing,
  Developer-panel rollout placement, workbench contribution configuration, and
  rich-text `agent-target` provider wiring.
- `@tutti-os/agent-gui` owns reusable Agent GUI presentation, target list
  consumption, target id propagation for first-iteration local CLI targets, and
  conversation-list filtering, and AgentGUI `@` palette grouping.
- `@tutti-os/workspace-external-core` owns the `agent-target` external `@`
  provider id contract.

Do not put durable Agent Target business rules only in `apps/desktop`.

## 13. Acceptance Criteria

### Data

- A fresh workspace has system Agent Targets for Codex and Claude Code.
- `launch_ref_json` is validated as a controlled union.
- Invalid launch refs are rejected or ignored safely.
- System targets cannot be accidentally deleted through normal target editing.

### Settings

- The Agent dock layout setting exists in the existing settings/preference
  system.
- Default value is `legacySplit`.
- First rollout exposes the control from the Developer settings panel.
- Changing the setting updates dock presentation without restarting the app.

### Target-First Runtime

- Starting a session with `agentTargetId` derives provider/runtime ref from the
  daemon-owned Agent Target record.
- Mismatched `agentTargetId` and provider values are rejected.
- Target-backed local CLI launches do not rely on opaque UI
  `providerTargetRef` as the runtime launch authority.

### Legacy Split

- Codex and Claude Code dock entries behave as they do today.
- Existing tests for provider-specific dock launch behavior still pass.

### Unified Dock

- Only one Agent dock entry is visible for Agent GUI.
- Codex and Claude Code Agent GUI nodes can both be open.
- The Agent dock popup groups all matching Agent GUI nodes.
- Clicking Agent when no node is open creates a node for the first available
  target.
- Legacy launch ids still route to the correct provider-specific node.

### Filtering

- The top filter includes All, Codex, and Claude Code only.
- Filtering changes the conversation list only.
- Composer provider/target state does not change when the filter changes.
- Historical sessions without target ids remain visible under provider filters.

### AgentGUI `@` Mention Palette

- AgentGUI shows agent candidates from `agent-target`, not `workspace-app`.
- The Agents tab includes `local:codex` and `local:claude-code` in first
  iteration.
- The Apps tab does not include `agent-codex` or `agent-claude-code`.
- Inserting a Codex or Claude Code agent mention creates an `agent-target`
  mention using the Agent Target id.
- New AgentGUI and external `@` queries do not create
  `mention://workspace-app/agent-codex?...` or
  `mention://workspace-app/agent-claude-code?...`.
- `window.tuttiExternal.at.query` includes `agent-target` results when
  `providers` is omitted.
- `window.tuttiExternal.at.query({ providers: ["workspace-app"] })` returns app
  results only and excludes agent targets.

## 14. Suggested Test Coverage

- Agent Target default row initialization and validation.
- `@tutti-os/workspace-external-core` accepts `agent-target` as a public
  external `@` provider id and includes it in the default provider list.
- Desktop rich-text `agent-target` provider maps Agent Target rows to mention
  query results.
- Desktop `workspace-app` mention provider excludes agent pseudo apps.
- External `@` bridge serializes `agent-target` query results and respects
  explicit provider filters.
- AgentGUI mention palette groups `agent-target` results under Agents and
  `workspace-app` results under Apps.
- Desktop preference default and update behavior for `agentDockLayout`.
- Workbench contribution creates split entries in `legacySplit`.
- Workbench contribution creates one grouped Agent entry in `unified`.
- Legacy dock ids still parse and launch the expected provider.
- Unified dock matches existing Codex and Claude Code nodes.
- Conversation filter model handles All, Codex, Claude Code, and historical
  sessions.
- Composer state is unchanged after filter changes.

## 15. Rollout

Phase 1:

- Add Agent Target registry with two system rows.
- Add the `agent-target` external `@` provider id and first desktop provider
  implementation.
- Remove agent pseudo-apps from `workspace-app` mention candidates.
- Add AB preference, defaulting to `legacySplit`.
- Keep current dock behavior unchanged by default.

Phase 2:

- Enable unified dock behind the setting.
- Add top filter in unified Agent GUI.
- Add AgentGUI Agents tab backed by `agent-target`.
- Carry system Agent Target ids through launch/runtime attribution for
  first-iteration local CLI targets.
- Verify historical session and node compatibility.

Phase 3:

- Design full target-aware composer UX.
- Add user-defined Agent Targets and profile/config tables if product scope
  requires them.
- Extend `agent-target` mention discovery to custom Agent Targets without
  adding one workspace app id or one CLI shortcut per custom agent.
