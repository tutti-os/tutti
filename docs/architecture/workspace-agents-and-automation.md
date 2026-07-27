# Workspace Agents And Automation Rules

Status: implemented architecture and migration contract

Applies to:

- `services/tuttid/biz/workspaceagent` and `service/workspaceagent`
- `services/tuttid/biz/automationrule` and `service/automationrule`
- `services/tuttid/service/agent/session_runtime_snapshot.go`
- Workspace settings Agent management and the Desktop Agent directory
- AgentGUI new-session selection, navigation, and session recovery

## Domain Boundary

The user-facing Agent is a workspace-scoped configuration, not a model role
and not the provider executable itself:

```text
Harness AgentTarget
  + primary ModelPlan / default model
  + name / description / instructions / call conditions
  + dormant contract fields: explicit fallback chain, Skills/tools allowlist
  = WorkspaceAgent (opaque Agent option id)
  -> AgentGUI directory and navigation
  -> SessionRuntimeSnapshot
```

The Wave 4-2 contract cleanup (feedback 2-1/2-6/2-8/2-9) reshaped this
contract:

- `purpose` was renamed to `description` (OpenAPI, daemon, and storage; the
  `workspace_agents_contract_cleanup_v1` migration copies stored purpose text
  into the new `description` column).
- The per-Agent `enabled` switch was retired. Every stored Agent is treated
  as launchable; only Harness/Plan availability gates Resolve. The migration
  normalizes legacy `enabled = 0` rows to enabled.
- `permissions` (free-form permission overrides) was deleted end to end:
  OpenAPI, daemon model, launch chain, runtime policy, and snapshot writes.
  The migration clears stored overrides. Old session snapshots that carry a
  `permissions` key are simply ignored on read.
- The assisted draft-generation endpoint and its schemas were deleted.
- `modelFallbacks`, `capabilitiesExplicit`, `skills`, and `tools` remain in
  the contract as dormant fields (no editor surface). The Desktop editor
  passes their stored values through on save instead of clearing them.

The objects have separate ownership:

| Object                   | Responsibility                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `AgentTarget`            | Daemon-owned Harness catalog: provider and trusted launch reference                 |
| `ModelPlan`              | Versioned endpoint, encrypted credential, protocol, and model catalog               |
| `WorkspaceAgent`         | Named workspace configuration that references one Harness and an optional ModelPlan |
| `SessionRuntimeSnapshot` | Immutable launch identity and non-secret effective configuration for one session    |
| `AutomationRule`         | Optional lifecycle trigger that launches one bounded target-Agent session           |
| `CollaborationRun`       | Durable fact and usage record for explicit user consult/fork/delegate/handoff       |

`agentTargetId` remains the opaque AgentGUI/session identity field for
compatibility, but a new `workspace-agent:*` value identifies a
`WorkspaceAgent`. Its `harnessAgentTargetId` is resolved only inside the
daemon. AgentGUI must never infer provider identity or launch authority from
the opaque id.

## Workspace Agent Lifecycle

Workspace settings create, edit, list, and delete Agents through
workspace-scoped daemon endpoints. A create request selects exactly one
Harness and may select one ModelPlan/default model. Saving a ModelPlan does not
create the Harness × Plan Cartesian product; Agent creation is an explicit
user action.

Desktop Settings keeps this ownership visible: Agent has General Settings,
Agent Runtime, Custom Agents, and Automation tabs in that order, while Model
Plans live in an independent top-level Model tab. Custom Agents is the only
new writable Harness × Plan mapping surface. The legacy Agent binding editor
must not be mounted elsewhere.

Every Agent update increments `revision`. The Desktop `AgentsService` loads
the current workspace directory and projects each Agent whose Harness is
available into an `AgentGUIAgent` using the Agent id unchanged. Multiple
Agents may share one provider and remain independently selectable,
filterable, and cacheable.

System AgentTargets stay available as the Harness catalog and as a legacy
session fallback. They are not the new Agent CRUD entity.

Assisted Agent draft generation was removed with the Wave 4-2 contract
cleanup (feedback 2-1): the `generate-draft` endpoint, its schemas, the
daemon generation service, and the Desktop entry point no longer exist.

## Runtime Resolution And Configuration Propagation

New-session resolution is workspace-aware:

```text
workspace-agent id
  -> WorkspaceAgent.Resolve(workspace, id)
  -> validate enabled Harness target
  -> try primary, then ordered explicit fallback Plan/model routes
  -> validate current Plan enablement, protocol, and model
  -> derive provider + trusted Harness launch ref
  -> apply Agent defaults and capability constraints
  -> prepare provider runtime
```

The runtime system prompt appends WorkspaceAgent instructions and records its
configured Skill/tool profile without allowing it to override Tutti security
or routing policy. A non-empty Agent Skill selection filters host/user Skill
sources while retaining daemon capability-pack Skills required for Tutti
routing. Structured permission and browser/computer capability settings
remain daemon-enforced; free-form labels are never treated as new authority
by themselves.

Composer options resolve the WorkspaceAgent's Harness and ModelPlan directly.
They do not look for a legacy binding whose key happens to equal the new Agent
id. Plan and Agent mutations publish target-scoped configuration invalidation
for the affected WorkspaceAgent ids.

The daemon composition root must wire both sides of this workspace-scoped
identity: `AgentSessionService.WorkspaceAgentResolver` resolves composer and
launch requests through the WorkspaceAgent service, while
`ActivityProjection.SetWorkspaceAgentTargetResolver` validates persisted
session targets through the workspace store. Omitting the former turns valid
composer/create requests into invalid requests; omitting the latter drops a
successfully created WorkspaceAgent target from the projected session.

Fallback resolution applies only while creating a new session. It does not
mutate the Agent, and the actual selected Plan/model/revision is persisted in
the immutable session snapshot. Editing fallback order affects later sessions
only. The daemon never searches unrelated Plans or provider-native credentials
after the explicit chain is exhausted.

## Immutable Session Runtime Snapshot

The session runtime context contains a versioned, redaction-safe snapshot:

- WorkspaceAgent id and revision
- Harness AgentTarget id and provider
- ModelPlan id, immutable revision, model, and safe fingerprint
- Agent description, instructions, call conditions, Skills, and tools
  (pre-cleanup snapshots stored the description under `purpose`; reads fall
  back to that key, and stale `permissions` keys are ignored)
- effective non-secret composer settings

API keys and endpoint secrets never enter session runtime context, events,
logs, or generated diagnostics. The immutable ModelPlan revision table owns
the encrypted historical endpoint configuration.

Resume behavior is strict:

1. Sessions created before snapshots retain the legacy current-binding path.
2. Snapshotted sessions validate that persisted Agent/provider identity still
   matches the snapshot.
3. The daemon resolves the exact recorded ModelPlan revision.
4. A missing revision fails explicitly; it never silently falls back to the
   current binding or provider-native credentials.
5. Current plan disablement/deletion is an authorization revocation and blocks
   future calls even when an old encrypted revision remains available.

This separates reproducible configuration from current authorization.

## Shared Agent Control-Plane Boundary

Cross-user Agent sharing is host/control-plane behavior, not a local tuttid
credential-copy feature. The owner remains the only credential holder. The
host maps the owner-domain target to the caller-local `shared-agent:*` identity
and projects a credential-free `sharedAccess` snapshot containing:

- grant and owner user ids;
- current owner-online state;
- optional run/token quota remaining and reset metadata;
- optional currency-denominated usage allowance;
- active/maximum concurrent sessions;
- the owner's allowed `(ModelPlan, model)` range, where a model entry without a
  Plan id applies to every otherwise-compatible Plan;
- whether consult, review, delegate, and upgrade capabilities are allowed; and
- a presentation hint that durable access auditing is required.

AgentGUI normalizes this snapshot and disables the target with stable reason
codes when the owner is offline, run/token or cost allowance is exhausted, or
concurrency is full. Its aggregate model picker omits models outside the
owner-projected range. The snapshot is presentation and defense in depth, not
authority.

The runtime passes the opaque target ref to the host adapter and invokes the
host `SharedAgentAccessController` for `start`, `resume`, every `settings`
change, every `turn`, and `release`. Requests include the actual selected
Model Plan, model, and turn capability, but never credentials. A control-plane
implementation must atomically acquire/release the concurrency lease, re-check
owner presence, quota, cost allowance, model range, and capability permission,
proxy the call to the owner, and never return the owner credential.
`SharedAgentAccessAuditor` receives every allowed and denied decision. Shared
target classification comes from the trusted target identity
(`shared-agent:*` or the normalized target kind), not from optional snapshot
fields. Missing/invalid grant identity, control-plane hooks, audit hooks, or
audit writes therefore fail closed. Owner-online, quota, cost, concurrency,
model, policy, and `auditRequired` values in the projected snapshot never make
runtime authorization decisions: the host authority must re-read current
state on every lifecycle action. Hosts install both hooks in the daemon
runtime `Config` before accepting session requests.

Standalone Tutti has no cross-user directory/control plane and therefore does
not fabricate shared Agents. External room hosts implement the access
controller, auditor, ID translation, membership, grant lifecycle, and proxy
transport; the shared AgentGUI/runtime packages enforce the common contract on
both sides of that boundary.

## Automation Rules

`AutomationRule` replaces the execution/planning/review role map for new
workflows. A triggered rule has exactly one behavior — launch a follow-up
session — and the former consult/fork/delegate/handoff action split is
retired from automation:

```text
trigger: on_task_complete | on_task_failed
source: optional WorkspaceAgent scope
target: WorkspaceAgent id or built-in Harness AgentTarget id
permissions: permission mode + allowed-tool constraint
budget: max runs and recorded target-session tokens per rule + source session
prompt: instruction placed in the launched session's first message
```

The launch goes through the normal session-create path, so Harness, Agent
revision, Plan revision, permissions, and runtime preparation are identical
to a user-created session. The rule's permission mode is applied strictly
(fail-closed) and its allowed-tools list narrows, never widens, the target
Agent's tool configuration. The first message is composed as rule prompt +
`mention://agent-session/<id>?workspaceId=...` source mention + a short
completed/failed event note; the target Agent reads source context through
the mention instead of an inline transcript copy. Built-in Harness targets
are always selectable, so automation works before any WorkspaceAgent exists.

Automation-origin sessions carry the originating rule id, source session id,
and bounded depth in runtime context. Failure-triggered rescue may evaluate
those sessions up to depth three. Completion never evaluates rules for
automation-origin sessions; the consult-based fixed acceptance Review retired
together with the action split. Evaluation is deduplicated by
workspace/session/rule/turn, runs asynchronously from activity persistence,
applies per-session overrides, and checks run/token budgets before execution.
Every launch writes an `automation_rule_executions` row plus an
`automation_rule.session_launched` audit log instead of a CollaborationRun;
the row is persisted before session creation so a duplicate trigger delivery
or restart can never double-launch, and the target session's terminal usage
is settled into it once. CollaborationRun and the `@model` consult remain
reserved for explicit user collaboration.

`on_task_failed` is the bounded automatic rescue path. A user can target a
stronger Agent while retaining the same per-source-session run/token limits
and session override. A failed or interrupted source turn can trigger it; an
automation-origin target may trigger the next configured rescue only below
the daemon's depth limit.

The launched session can read the source conversation through the session
mention. This is intentional context sharing, not secret redaction: the rule
target must be treated as a recipient of that conversation. ModelPlan
credentials and endpoint configuration never enter the prompt or the
execution ledger.

The same WorkspaceAgent launch boundary serves explicit Composer `@Agent`
requests. Manual launches require the user to choose Fork, Delegate, or
Handoff plus `none`, `recent`, or `full` source context. The daemon—not the
renderer—loads the canonical bounded transcript before creating the target
Session; the renderer's context preview is explanatory UI only.

The active-conversation Handoff menu is a quick entry into that same durable
path, not a renderer-only window shortcut. It starts a `handoff`
CollaborationRun with recent bounded context and trigger reason `handoff_menu`,
requires the daemon to return a real target Session, and opens that Session
only after the running record exists. Launch failure keeps the source Session
selected and visible and reports the failure; successful Handoff moves the
user to the target Session for subsequent execution while preserving the
source as readable history.

Budget enforcement currently has narrower semantics than a general cost cap:

- each rule has an independent budget for each source session;
- zero means the defaults (three runs and 200,000 recorded tokens), not
  unlimited;
- every launch attempt counts one run, including a failed launch;
- token usage comes from the `automation_rule_executions` ledger: the target
  session's reported input, output, cache-read, and cache-write counters are
  settled into the execution row on its first terminal turn. Providers
  report the most recent model request rather than a session cumulative
  total, so the run cap is the effective guard; unavailable counters remain
  zero and are not guessed;
- the daemon checks the accumulated total before starting. It does not
  reserve the next launch's usage, cancel an in-flight session, or guarantee
  that the final total stays below the threshold because usage is not known
  in advance.

The public daemon contract exposes workspace rule CRUD at
`/v1/workspaces/{workspaceID}/automation-rules` and session selection/disable
overrides at
`/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/automation-rule-override`.
Responses carry target kind, capability constraints, narrowed permissions,
and per-session budgets; they never carry ModelPlan credentials.
Successful rule create, update, and delete operations publish the
workspace-scoped `agent.automation.rules.changed` business event so clients can
refresh the authoritative rule list without polling.

Desktop Workspace Settings exposes the workspace CRUD contract directly. The
editor offers the lifecycle trigger, optional source Agent, one target Agent
(built-in Harness targets merged with enabled WorkspaceAgents, so the picker
is never empty), narrowed permissions, prompt, and budgets without
recreating execution/planning/review roles. The permission-mode and
allowed-tools option catalogs load from the selected target's composer
capability directory, and switching targets drops selections the new target
does not offer. A new draft starts disabled and uses the defaults of three
runs and 200,000 tokens per source session. A stored zero continues to mean
those same daemon defaults.

AgentGUI surfaces session-local rule selection through the shared
`AgentActivityRuntime` list/get/set commands. A new-conversation choice is
carried in `CreateWorkspaceAgentSessionRequest` and persisted by `tuttid` after
the provider runtime starts but before the initial prompt executes; this avoids
a first-turn race with `on_task_complete` or `on_task_failed`. An active-session
choice uses the dedicated override endpoint immediately. Empty rule ids with
`disabled=false` inherit workspace defaults, `disabled=true` turns automation
off for that session, and a non-empty list selects that explicit rule subset.
The renderer never evaluates rules or keeps a host-specific override store.

Legacy `modelpolicy` CRUD and acceptance state remain readable during
migration. The legacy runtime review runner is disabled; the observer only
maintains the compatibility `agent_claimed` acceptance record. Execution and
planning role fields do not drive the new runtime and are not converted into
implicit rules. The Plan/default model copied into a migrated WorkspaceAgent
comes from its fixed-target binding, not from a model role. The
`automation_rules_v2` migration removes legacy model-target consult rows —
they cannot express the single launch semantic — and clears the retired
action discriminator on the surviving agent-target rows.

## Migration And Compatibility

The upgrade is additive and rollback-safe:

- Existing `agent_target_model_bindings` stay in place for historical-session
  reads and rollback compatibility; Desktop does not create new rows.
- Each binding deterministically backfills one named WorkspaceAgent; rerunning
  the migration is idempotent.
- The original Harness target remains available for configuration, historical
  resolution, and empty-directory fallback. Once a WorkspaceAgent exists, it
  is not shown as a parallel primary Agent choice.
- Enabled legacy review rules with a review Plan and bound source target
  backfill deterministic AutomationRules and matching session overrides.
- Historical sessions keep their recorded target id and transcript.
- Configured Agent sessions use WorkspaceAgent ids and immutable snapshots;
  the explicit empty-directory fallback may still launch a raw system target.

## Validation

Run focused Go tests for the WorkspaceAgent, AutomationRule, ModelPlan revision,
and agent runtime packages, then the generated-contract and Desktop checks:

```sh
cd services/tuttid
go test ./biz/workspaceagent ./service/workspaceagent
go test ./biz/automationrule ./service/automationrule
go test ./data/workspace ./service/agent
cd ../..
pnpm check:api-generated
pnpm check:agent-activity-runtime-boundaries
pnpm check:changed
```

## What To Avoid

- Do not bind a ModelPlan directly to a provider id in renderer state.
- Do not create duplicate Agents automatically for every Plan/Harness pair.
- Do not resolve a WorkspaceAgent id through the global Harness table.
- Do not use provider as AgentGUI identity; multiple Agents may share it.
- Do not re-read current bindings when a session has an immutable snapshot.
- Do not persist credentials in WorkspaceAgent, AutomationRule, Session, or
  CollaborationRun payloads.
- Do not copy an owner's ModelPlan credential into a shared target ref or
  caller database. Shared execution goes through the owner/control-plane proxy.
- Do not use a stale projected quota/online snapshot as the authoritative
  check; the host access controller must re-check every launch and turn.
- Do not model planning or review as privileged model roles; express optional
  cross-model work as an explicit collaboration action.
- Do not present `maxTotalTokensPerSession` as a hard cap on descendant Agent
  turns or monetary cost; current accounting is CollaborationRun-based.
