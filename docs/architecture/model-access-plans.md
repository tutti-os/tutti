# Model Access Plans and Workspace Agents

Status: living architecture document for the unified model access domain.

Applies to:

- `services/tuttid/biz/modelplan`, `biz/workspaceagent`, `biz/automationrule`, `biz/modelbinding`, `biz/collabrun`
- `services/tuttid/service/modelplan`, `service/workspaceagent`, `service/automationrule`, `service/modelbinding`, `service/collabrun`
- `services/tuttid/service/agent/model_plan_binding.go` (runtime integration)
- `services/tuttid/service/agent/session_runtime_snapshot.go` (immutable session configuration)
- `packages/agent/runtimeprep/model_endpoint.go` (provider credential injection)
- `services/tuttid/service/cli/providers/modelconsult` (CLI-invoked consult)
- The workspace settings "模型方案" surface (the dedicated Model settings tab;
  WorkspaceAgents and automation rules live under the Agent tab) and the
  AgentGUI composer model selector

## Why This Exists

Users hold fragmented model access: official Agent subscriptions, coding
plans, domestic providers, relay gateways, and raw API keys. The product goal is to
let a user configure an access scheme once and explicitly combine it with a
Harness target to create a named Agent option. Editing an Agent may switch its
plan/model without creating another Agent; Tutti never generates a
Harness-by-ModelPlan Cartesian product.

## Domain Objects

The primary user-facing composition is workspace-scoped:

| Object                                        | Answers                                                                                                                                                 | Package              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Model access plan (`modelplan.Plan`)          | "What model access do I own?" — protocol, billing semantic, credential, base URL, models/capabilities/pricing, detection, revision, and first-use state | `biz/modelplan`      |
| Workspace Agent (`workspaceagent.Agent`)      | "Which selectable Agent do I want?" — name/purpose + Harness + primary Plan/model + ordered fallback routes + instructions/skills/tools/permissions     | `biz/workspaceagent` |
| Legacy model binding (`modelbinding.Binding`) | Compatibility source for pre-WorkspaceAgent fixed-target configuration                                                                                  | `biz/modelbinding`   |

Deleting a WorkspaceAgent never deletes its Harness target or ModelPlan.
Multiple named Agents may share either component. WorkspaceAgent ids are
opaque `workspace-agent:*` values and double as the AgentGUI/session
`agentTargetId`; the daemon resolves them back to the underlying Harness at
launch. Fixed system targets remain in the global Harness catalog for history
and legacy fallback, not as the primary configured Agent directory.

## Credential Ownership

- Endpoint-backed Plans store current and immutable historical credentials as AES-256-GCM encrypted
  at rest in `model_plans` and `model_plan_revisions`
  (`api_key_ciphertext`), sharing the managed-credential key derivation.
- API responses expose only `hasApiKey`. The credential leaves the daemon in
  exactly two shapes: the session process environment
  (`TUTTI_MODEL_PLAN_API_KEY`, `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`) and
  the short-lived workspace-app grant broker. App grants store Plan ids, not
  copied credentials, and resolve the current usable Plan only when the app
  requests a credential lease.
- Credentials must never appear in logs, events, timeline payloads, detection
  results, or generated provider instructions. `runtimeprep` writes the Codex
  provider table with `env_key`, never the key value.
- `runtimeprep.PrepareInput.ModelEndpoint` is a private process-materialization
  input. Capability resolvers and lifecycle callbacks receive only
  `runtimeprep.PrepareContext`, which intentionally excludes endpoint URL,
  credential, Plan name, and Plan identity. Only the concrete provider
  preparer may read the endpoint secret to construct provider config and
  environment variables.
- `official_subscription` is provider-native, not an alias for the provider's
  metered API. It stores neither an API key nor a Base URL. OpenAI protocol
  selects the built-in Codex target and Anthropic protocol selects the
  built-in Claude Code target; both reuse the login already owned by that
  provider runtime. Coding Plan, relay, domestic, and custom schemes remain
  endpoint-backed and request only the credential/URL fields relevant to that
  scheme.

### Shared-Agent Owner Boundary

A shared-Agent host projects only a credential-free access snapshot into the
directory entry: grant/owner ids, owner-online state, token and cost quota,
concurrency, allowed Plan/model pairs, `consult`/`review`/`delegate`/`upgrade`
permissions, and whether owner-side audit is mandatory. AgentGUI normalizes
that snapshot and fails closed before known-disallowed work: exhausted quota
or concurrency disables the target, `delegate=false` blocks explicit Agent
collaboration, `upgrade=false` leaves only the current Plan/model, and the
allowed-model list is always intersected with compatible workspace options.

This projection is an early UI guard, not the authority. Actual start, update,
and turn requests carry their exact requested Agent/Plan/model/capability to
the owner control plane, which owns credentials, atomic quota/concurrency
accounting, policy authorization, and mandatory audit writes. A missing or
failed owner authorization/audit result must reject the operation; the caller
daemon must never receive or reconstruct the Owner's credential.

## Staged Detection And First Use

`modelplan.Service.Detect` runs four daemon-verifiable stages in order —
`network → auth → model_discovery → inference` — each with a machine-readable
`failureReason`/`remedy` code that UI layers localize. The fifth stage,
`agent_runtime`, stays `pending` until the first real agent call through the
plan completes; a plan therefore reads `pending_first_use` after a successful
save+detect and becomes `ready` only after
`modelplan.Service.MarkFirstUse` fires. That marker is driven by the agent
service session-state observer when a plan-bound session settles a turn with a
completed outcome. Saving is never "fully usable"; only real use is.

A failed first real call is also durable evidence. The same observer records
the `agent_runtime` stage as failed with a stable failure reason/remedy and the
attempted Agent, Session, and model context. The Plan remains retryable: a later
successful real call replaces that failed stage and moves the Plan to `ready`.

Desktop renders `pending_first_use` as an actionable final setup step. It
filters enabled Agent targets by the Plan protocol, lets the user choose one,
and opens a new AgentGUI draft preloaded with the exact Plan and its default
model. The user still sends the real call; the setup screen does not fake or
silently auto-submit verification. Embedded and standalone launch routes carry
the same pre-session assignment and never modify an existing Session.

Providers without a `/models` catalog (404 on every candidate) keep working:
discovery is `skipped` when manual models exist and the inference stage
becomes the authoritative credential check.

Provider discovery is a candidate catalog, not a user selection. When an
endpoint-backed draft has no selected model but discovery returns candidates,
detection may use the first candidate only as the ephemeral inference target
for that run. The tested id is recorded in the detection snapshot, while the
Plan's `models` and `defaultModel` remain unchanged until the user selects one.

Official subscriptions use the same visible stage model with different
authorities: `network` verifies that the matching built-in Agent runtime is
installed and enabled, `auth` verifies its provider-native login,
`model_discovery` reads the provider's composer/runtime catalog, and
`inference` runs one real minimal prompt through that native runtime. The
probe ignores mutable workspace target bindings, disables automation, hides
and deletes its temporary Session, and never receives a provider credential.
This detection inference does not satisfy `agent_runtime`; the separate,
user-sent first-use call remains required for acceptance and durable readiness.

## Runtime Injection Chain

```text
WorkspaceAgent (workspace settings)
  -> workspaceagent.Service.Resolve (Agent revision + Harness + exact plan)
  -> agent.Service.resolveCreateSessionLaunch
  -> runtimeprep.PrepareInput.ModelEndpoint
  -> CodexPreparer: session config.toml [model_providers.tutti-model-plan] + env_key
     ClaudeCodePreparer: ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN
  -> provider runtime speaks to the plan endpoint for the whole session
```

For `official_subscription`, the same resolution retains Plan identity and
model-range validation but `runtimeprep.ModelEndpointConfig` is intentionally
credentialless. Runtime preparation therefore performs no endpoint injection
and Codex/Claude Code continues with its provider-native login. Endpoint-backed
plans follow the injection chain above.

Plan identity and immutable revision remain daemon-owned session metadata.
They are recorded in the model resolution and runtime snapshot, but are not
fields on `runtimeprep.ModelEndpointConfig`; the endpoint DTO carries only the
protocol, Base URL, API key, model, and redaction-safe display name needed by
the concrete provider preparer.

`modelbinding.Binding` remains a compatibility fallback for raw system target
ids. New WorkspaceAgent launches bypass that mutable binding and carry the
resolved Agent revision, Harness id, instructions/skills/tools/permissions,
and immutable plan revision into the session runtime snapshot.

Rules:

- Protocol compatibility is explicit in the canonical provider-registry
  runtime endpoint strategy: `codex`/`tutti-agent` consume `openai` plans and
  `claude-code` consumes `anthropic` plans. The generated AgentGUI catalog
  mirrors that strategy for Desktop filtering. Providers without a declared
  protocol receive no endpoint injection and expose no model-plan binding UI.
- A WorkspaceAgent resolves its primary Plan/model and then only its explicitly
  configured ordered `modelFallbacks`. Missing, disabled, protocol-mismatched,
  or model-incompatible candidates are skipped. There is no arbitrary
  cross-credential fallback and no provider-native fallback for a configured
  WorkspaceAgent. If no explicit route is usable, launch fails before provider
  startup. Legacy raw system targets retain their compatibility behavior.
- A plan-bound session validates requested models against the plan's model
  list (`validateModelAgainstPlan`), not provider catalogs.
- Composer options for a WorkspaceAgent with a Plan (or a legacy bound raw
  target) replace provider-native model options with the Plan's models
  (`applyModelPlanComposerOverlay`); each option carries the source Plan name
  and `runtimeContext.modelPlan = {id, name, protocol}`.

## Model Switch Semantics

- The AgentGUI model picker is workspace-global for the selected Harness
  protocol: it aggregates every enabled `ready`/`pending_first_use` Plan and
  gives each option a collision-free `(modelPlanId, model)` selection value.
  Rows expose the source Plan, `api_metered` or `subscription_quota` billing
  semantic, tier, capabilities, permitted optional pricing, and the effective
  switch behavior. Search, favorites, and recents operate on that composite
  identity, never on a model id alone.
- Within one plan (same credential/base URL): the model change applies to the
  next call of the same session — `modelSwitch` capability, existing session
  settings update path.
- Across plans or credential sources: always a new session (the endpoint is
  fixed at session start). UI presents this as "will apply in a new session",
  stages the composite selection without sending a live settings update, then
  creates that Session on the user's next submit. The new Session keeps the
  same WorkspaceAgent identity and receives a `mention://agent-session/...`
  reference instructing it to recover only the minimum necessary context.
  There is no pretend hot switch.
- `AgentSessionComposerSettings.modelPlanId` is a read-side projection of the
  immutable runtime snapshot. The session-settings endpoint rejects any
  attempt to mutate it; clients must use session creation for a different
  Plan.
- WorkspaceAgent or Plan edits affect new sessions. Existing sessions keep
  their recorded Agent/Plan revisions; an explicit same-Plan session model
  update may affect the next call that has not started.

## Recommendation, Failover, And Pricing

`modelplan.RecommendModels` is the single deterministic routing policy used by
the daemon API, CLI, and Desktop fallback editor. It filters disabled Plans and
models that do not contain every requested capability. Ranking is:

1. lifecycle health (`ready`, `pending_first_use`, `undetected`, then
   `detection_failed`);
2. explicit preferred Plan;
3. published API-metered pricing presence and lower blended unit price when
   currencies match;
4. stable Plan/model ids.

Each model has a user-editable `flagship`, `standard`, or `economy` tier
(`standard` is the backwards-compatible default). Tier is returned with every
model and recommendation as a human decision aid; it does not replace required
capability checks or optional pricing. The result includes machine-readable
reasons, tier, capabilities, lifecycle status, and optional pricing; it never
includes credentials. Callers use
`POST /v1/workspaces/{workspaceID}/model-plans/recommend` or
`tutti agent recommend-models --required-capability ...`. The Desktop Agent
editor asks the daemon for a capability-compatible route and appends the
chosen Plan/model to the explicit fallback chain; users can still edit order
manually.

`templateKind` determines a redaction-safe `billingMode`: official
subscriptions and Coding Plans use `subscription_quota`; domestic, relay, and
custom endpoints use `api_metered`. Pricing is accepted only for API-metered
plans as optional currency micros per million input, output, cache-read, and
cache-write tokens. The daemon strips submitted subscription prices during
normalization and also removes legacy residual prices from public projections,
recommendations, and cost lookup. This fail-safe prevents stale records from
fabricating a subscription amount.

The Issue orchestration service uses API-metered pricing for estimates and run
cost projection. Subscription plans instead use provider-reported remaining
quota against the configured waterline. Unknown prices stay unknown; the
system does not treat them as zero, invent a price, or compare numeric values
across currencies.

Failover is a new-session resolution operation only. The selected route and
exact Plan revision enter the immutable session snapshot. A running session
never swaps endpoint, owner credential, or Plan revision after an error.

### Configuration Change Propagation

Successful Plan, WorkspaceAgent, or compatibility-binding mutations publish
the workspace-scoped `agent.model.configuration.changed` event with the
affected `agentTargetId` values. Desktop activity services use those opaque
target ids to invalidate
only the matching composer-options cache entries, including matching in-flight
requests. The event is a low-latency hint, not the source of truth: event loss,
coalescing, reconnect, or out-of-order delivery must not determine the selected
model.

Every composer-options response carries a redaction-safe
`runtimeContext.modelConfiguration = {agentTargetId, source, fingerprint,
defaultModel}` snapshot derived from the selected WorkspaceAgent (or a legacy
binding) and compatible Plan. The fingerprint includes only model-selection
inputs; endpoint URLs and credentials are excluded. AgentGUI compares this
authoritative snapshot on
initial load and after invalidation, then persists the workspace/target model
state in the workbench snapshot. A changed fingerprint resets only the
home/new-conversation model to the new default; an unchanged fingerprint keeps
an explicit user selection. Provider-native, disabled, unbound, and
protocol-mismatched states do not inherit a stale plan model.

Active-session settings remain untouched. AgentGUI also must not write an
automatic plan reconciliation into desktop-wide remembered target defaults:
desktop preferences are not workspace-scoped, so doing so would leak one
workspace's plan into another. Ordinary provider catalog invalidation remains
a separate event and preserves an explicit home model.

## Automation Rules, Not Model Roles

New behavior is action-centric. `AutomationRule` combines an explicit
lifecycle trigger (`on_task_complete` or `on_task_failed`) with `consult`,
`fork`, `delegate`, or `handoff`:

- `consult` targets a ModelPlan/model and is always tool-free;
- `fork`, `delegate`, and `handoff` target a WorkspaceAgent and use its normal
  Harness, Plan revision, instructions, skills, tools, and permissions;
- an optional source WorkspaceAgent scopes the rule without creating an
  execution/planning/review hierarchy;
- per-session overrides may disable automation or select a subset of rules.

An automated Agent's failed turn may match another `on_task_failed` rule, so
workspaces can configure conditional multi-level rescue by scoping successive
rules to stronger or specialized source Agents. Runtime context carries the
automation depth into every launched Session. Failure triggers may chain from
an automation-origin Session, and the daemon stops before launching past depth
three. Completed automation turns do not run ordinary completion rules; the
only exception is an Issue's fixed acceptance Review, which records a
candidate review result and still never accepts work for the user. Per-rule
run/token budgets apply at every level. This boundary is deliberately finite
and must not be replaced with unlimited recursive rescue.

Legacy `modelpolicy` CRUD and acceptance records remain readable for
compatibility. The old runtime review runner is disabled; its observer only
maintains the legacy `agent_claimed` acceptance state. Enabled legacy review
rules migrate to `on_task_complete -> consult` AutomationRules. The former
execution and planning role fields do not drive the new runtime and do not
become implicit rules. A legacy binding's effective Plan/default model instead
becomes the migrated WorkspaceAgent configuration.

### Current Token-Budget Semantics

An AutomationRule budget is independent for each `(rule, source session)`.
Zero values select the defaults: three runs and 200,000 recorded tokens. The
run-count limit covers all actions. The token counter sums input, output,
cache-read, and cache-write usage from matching CollaborationRuns; consult
runs report all categories exposed by the provider, while
fork/delegate/handoff begin as `running` and copy the same four categories from
the target turn's terminal runtime state. Unavailable usage remains
unknown/zero rather than being estimated.

Enforcement is a pre-run threshold check, not a reservation or hard streaming
cap. A consult's requested output limit is the smaller of 2,048 and the
remaining recorded-token budget. Input tokens can still take the cumulative
total past `maxTotalTokensPerSession`; that total blocks the next matching run.
The budget does not cancel an in-flight call and is not a currency/cost
estimate.

## Collaboration Runs

`collabrun.Run` records every 模型咨询 (consult) / Fork / 委派 (delegate) /
Handoff with trigger source and reason, source/target sessions, actual plan
and model, context scope, status, immutable attempt/retry lineage, duration,
token usage, failure stage, estimated metered cost, and result adoption.
Consult executes daemon-side through the plan protocol client
(`modelplan.Service.Complete`) with an advisor system prompt — advice only, no
tools, ownership stays with the source session. Fork/delegate/handoff callers
persist a `running` record before creating the target session. The daemon
settles it from the exact target turn as completed, failed, or canceled and
captures terminal duration, actual Agent/Plan/model identity, and reported
input/output/cache-read/cache-write usage. Session-create failures settle the
same record as failed;
daemon restart reconciliation maps interrupted target turns to failed runs.
Cancel routes consults to the completion cancel function and session-backed
runs to exact-turn cancellation. Updates publish on the strict-schema
`agent.collaboration.updated` topic and update one source timeline card in
place.

Retry never mutates the failed record. The retry endpoint replays the durable
request/context as a newly linked attempt, so the source timeline preserves
what failed, where it failed, and how many attempts were made. Old records
that predate durable request capture fail explicitly instead of reconstructing
different input. Metered API runs estimate cost only from provider-recorded
usage and the exact Model Plan/model rates; subscription-quota runs omit
currency cost rather than fabricating a marginal price.

The same credential-free durable request is projected onto the source
timeline card. A failed card can therefore retry the exact configuration,
return the request to Composer for a user-selected replacement Model Plan,
model, or Agent, or reject the result and return control to the source user.
Returning to Composer creates a new collaboration when submitted and never
rewrites the failed run or its accounting lineage.

For manual Agent collaboration, `StartAgentRun` owns the record-before-launch
boundary. It requires the source Session, target WorkspaceAgent, explicit
Fork/Delegate/Handoff mode, request text, and one of `none` / `recent` /
`full`. When the caller omits `targetSessionId`, the daemon allocates it,
selects the bounded canonical source transcript (12 messages / 8 KiB for
recent; 48 messages / 32 KiB for full), and launches the target through the
normal Agent Session service. A renderer-provided `contextText` is only an
explicit supplement and never replaces daemon-selected history.

`TriggerSource` distinguishes who started a collaboration: `automation`/`policy` (an
`AutomationRule` lifecycle trigger), `user` (a host-gated programmatic
`startModelConsult` command or explicit Composer `@Agent` launch; there is no
composer consult button), and
`agent` — an agent session invoking consult on its own initiative through the
CLI, exactly like any other `tutti agent ...` command it already has access to
(`agent model-plans` to discover a plan/model, `agent consult` to start one;
`services/tuttid/service/cli/providers/modelconsult`). The CLI command
defaults `SourceSessionID` from the invoking session's `TUTTI_AGENT_SESSION_ID`
environment variable, so the agent never has to pass its own session id. This
is what makes "advisor mode" a tool the agent can reach for mid-task, not a
human-triggered UI affordance; the daemon-side mechanics (budget checks,
tool-free completion, timeline reporting) are identical across all trigger
sources.

Users steer this from the prompt: the composer's @ panel offers a
`workspace-model` mention listing every enabled Plan's models. The inserted
`mention://workspace-model/<modelId>?modelPlanId=...&workspaceId=...` link is
routed by the runtime policy to `tutti agent consult`, so "你可以咨询一下
@某模型" becomes an explicit, user-directed agent-triggered consult.

## Migration

`model_plans_v1` backfills every legacy `managed_model_provider_credentials`
row into a named plan (`mp-migrated-<provider>`), copying the ciphertext
as-is. Legacy provider rows remain only as a compatibility fallback when no
usable Plan matches a requested provider. Existing provider-scoped App
requests are translated to every usable Plan with that protocol; new unscoped
workspace-app grants use all usable Plans. Both paths therefore reuse the same
encrypted credential as Agents, automation, and policies. Historical sessions
are untouched: bindings only affect sessions that have not started.

`managed_credentials_model_plans_v1` adds `model_plan_ids_json` to app grants.
The grant catalog returns `modelPlanId` and `modelPlanName` on each Plan-backed
model. Credential requests may name that Plan explicitly; provider + model is
accepted only when it resolves to exactly one granted Plan, preventing silent
credential selection when two Plans expose the same model id.

`model_plan_revisions_v1` records revision 1 for existing Plans and thereafter
keeps each encrypted endpoint configuration immutable for exact session
resume. Deleting a current Plan does not erase historical revisions, but
current Plan deletion or disablement revokes future use.

`workspace_agents_v1` backfills one deterministic named Agent for every
legacy fixed-target binding. Its id is derived from `(workspaceId,
harnessAgentTargetId)`, its effective default model follows the binding first
and the plan default second, and its source is `legacy_binding`. The old
binding and fixed target are retained for rollback and historical sessions;
the migration is additive and idempotent.

`workspace_agents_model_fallbacks_v1` adds the credential-free ordered
Plan/model route list. Empty means no fallback. Every referenced fallback Plan
participates in delete protection with role `fallback`.

`automation_rules_v1` migrates enabled legacy review rules with a review Plan
into deterministic `on_task_complete -> consult` rules and carries matching
session disable/selection overrides. It deliberately does not reinterpret
legacy execution/planning roles as automation actions.

## Reference Protection

`DELETE /v1/workspaces/{id}/model-plans/{planId}` is blocked (409
`model_plan_referenced`) while WorkspaceAgents, AutomationRules, active
workspace-app grants, policies, or compatibility bindings reference the plan;
`GET .../references` lists the consumers so the UI shows impact before edits.
The resolver composes per-consumer sources, including
`workspaceagent.Service`, `automationrule.Service`,
`managedcredentials.Service`, and `modelbinding.Service`. Revoked or expired
App grants do not block deletion.

Desktop also performs that reference review before saving an existing Plan
whose model-id set changed. The first save attempt fetches and displays every
current consumer; a second explicit confirmation applies the update. Credential
or endpoint edits still require staged re-detection. Neither edit changes an
in-flight call, and existing immutable Session snapshots retain their recorded
Plan revision.

## What To Avoid

- Do not add a "global current model" that switches every agent at once; the
  plan/default is owned by an explicit WorkspaceAgent.
- Do not auto-create one Agent for every Harness × ModelPlan combination;
  Agent creation is an explicit user action.
- Do not surface plan credentials to the renderer, tests, or snapshots.
- Do not treat recommendation as authorization: launch revalidates the chosen
  Plan, model, protocol, and current enablement.
- Do not silently add a fallback or switch an in-flight session; fallback must
  be explicit on the WorkspaceAgent and is resolved only for a new session.
- Do not advertise `modelPlanBinding` for providers without a real injection
  path.
- Do not encode execution, planning, or review as privileged model roles;
  create a named WorkspaceAgent or an explicit AutomationRule.
- Do not describe the token budget as a hard cap on target-agent tokens or
  monetary spend; current accounting is CollaborationRun-based.
