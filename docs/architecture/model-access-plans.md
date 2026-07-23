# Model Access Plans

Model access plans are daemon-owned, per-workspace configurations for routing
supported agent runtimes through a named model endpoint. A plan owns its wire
protocol, endpoint, encrypted credential, model catalog, default model,
detection state, and enabled state.

This slice owns Plans. `WorkspaceAgent` is the user-facing configuration seam
that combines one Harness AgentTarget with an optional Plan/default model and
instructions. The older per-AgentTarget binding and `modelpolicy` domains are
compatibility-only: they remain readable for historical sessions and deletion
protection, but Desktop Settings must not expose them as parallel writable
configuration.

## Ownership

- `services/tuttid/biz/modelplan` owns the Plan model and validation.
- `services/tuttid/data/workspace` owns Plan persistence and retains legacy
  binding persistence during the compatibility window.
- `services/tuttid/service/modelplan` owns CRUD, staged endpoint detection,
  and deletion protection.
- `services/tuttid/service/workspaceagent` owns every new Harness-to-Plan
  mapping. `services/tuttid/service/modelbinding` is a legacy adapter and
  reference source; Desktop no longer calls its write routes.
- `packages/agent/daemon/providerregistry` declares whether a provider runtime
  accepts a model-plan endpoint and which protocol it consumes.
- `packages/agent/runtimeprep` contains the provider-specific endpoint
  adapters. Codex and Tutti Agent receive a session-scoped Codex provider
  configuration; Claude Code receives its supported environment contract;
  OpenCode receives a session-scoped `opencode.json` provider block via
  `OPENCODE_CONFIG` (credential travels only as `TUTTI_MODEL_PLAN_API_KEY`
  with an `{env:…}` reference in the file).
- `services/tuttid/service/agent` resolves the WorkspaceAgent and supplies its
  Plan endpoint to runtime preparation. Unsnapshotted historical sessions may
  still use the isolated legacy-binding fallback.
- Desktop settings and AgentGUI composer surfaces consume the daemon APIs
  behind the `lab.modelPlans` gate; they do not own plan credentials or
  detection state.

Provider support is fail-closed. A provider may advertise
`modelPlanBinding` only when its registry descriptor declares a protocol and a
matching runtime-preparation adapter exists. OpenCode consumes `openai` plans
through that path; Cursor currently keeps its provider-native credential
source. Provider catalog identity carries `modelPlanProtocol` so desktop
resolves protocols through the catalog instead of provider-identity switches.

## Request And Runtime Flow

1. A client creates a Plan through the OpenAPI-defined daemon route. Saving
   does not require or trigger detection; the user may explicitly run the
   connection check on any saved Plan.
2. The user explicitly creates a WorkspaceAgent by choosing one Harness and,
   optionally, one Plan/default model. Saving a Plan never creates the Harness
   × Plan Cartesian product.
3. Before a new session starts, tuttid resolves that WorkspaceAgent and
   validates its requested model against the Plan catalog.
4. Runtime preparation injects the endpoint and credential only into the
   session-scoped provider environment/configuration. Credentials are never
   returned by the API or written into generated instructions and manifests.

Disabling a plan prevents new sessions from using it; existing running
sessions are not interrupted. Deleting a plan is rejected while any consumer
still references it: agent target bindings and model-usage policies both
count. The references API returns `agent_target` and `model_policy` entries,
each carrying the consumer's role (bindings report `default`; policies report
`execution`, `planning`, or `review`). Symmetrically, deleting a model-usage
policy is rejected while any agent binding still references it; rebind or clear
those bindings first.

## Rollout Gate

Model Plan write routes require the device-global `lab.modelPlans` preference.
Reads and historical runtime compatibility continue to work when the flag is
off. Missing or unreadable preferences fail closed for writes. Desktop exposes
Plans in an independent top-level Model tab; `lab.workspaceAgents` separately
gates the Custom Agents tab under Agent.

## Credential Ownership

- Plan credentials are AES-256-GCM encrypted at rest in `model_plans`
  (`api_key_ciphertext`), sharing the managed-credential key derivation.
- API responses expose only `hasApiKey`. The credential leaves the daemon in
  exactly two shapes: the session process environment
  (`TUTTI_MODEL_PLAN_API_KEY`, `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`) and
  the legacy workspace-app grant broker.
- Credentials must never appear in logs, events, timeline payloads, detection
  results, or generated provider instructions. `runtimeprep` writes the Codex
  provider table with `env_key`, never the key value.

## Staged Detection

`modelplan.Service.Detect` runs four daemon-verifiable stages in order —
`network → auth → model_discovery → inference` — each with a machine-readable
`failureReason`/`remedy` code. A Plan becomes `ready` when all four stages pass
or are explicitly skipped. Saving a new or changed Plan never runs this check
and never blocks on its result: a new Plan starts `undetected`, and connection
changes reset it to `undetected` until the user runs the saved-row check.

Providers without a `/models` catalog (404 on every candidate) keep working:
discovery is `skipped` when manual models exist and the inference stage
becomes the authoritative credential check.

Provider discovery is a candidate catalog, not a user selection. When an
endpoint-backed draft has no selected model but discovery returns candidates,
detection may use the first candidate only as the ephemeral inference target
for that run. The tested id is recorded in the detection snapshot, while the
Plan's `models` and `defaultModel` remain unchanged until the user selects one.

`official_subscription` uses a different adapter behind the same stages. The
provider registry chooses the one native runtime for each protocol (Codex for
OpenAI and Claude Code for Anthropic). Detection checks installation/runtime,
the provider's existing login, provider-native model discovery, and one hidden
minimal inference call. It never accepts a Base URL/API key or returns native
credentials. Endpoint-backed templates continue to use the HTTP detection
path.

## Runtime Injection Chain

```text
WorkspaceAgent primary Plan/default model
  -> agent.Service.resolveModelPlanEndpoint (Create + prepareRuntime)
  -> runtimeprep.PrepareInput.ModelEndpoint
  -> CodexPreparer: session config.toml [model_providers.tutti-model-plan] + env_key
     ClaudeCodePreparer: ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN
     OpenCodePreparer: session opencode.json provider block via OPENCODE_CONFIG
  -> provider runtime speaks to the plan endpoint for the whole session
```

Rules:

- Protocol compatibility is explicit: `codex`/`tutti-agent`/`opencode` consume
  `openai` plans, `claude-code` consumes `anthropic` plans. Cursor keeps
  provider-native credentials (no endpoint injection) — no fake UI entry
  points.
- Model addressing is a second registry strategy
  (`ModelPlanModelAddressing`): OpenCode declares `provider_prefixed`, so its
  composer/settings values carry the injected `tutti-model-plan/<model>`
  namespace resolved against the session-scoped provider block. Other providers
  consume raw plan model ids; validation strips the namespace back to
  plan-domain ids.
- Disabled or protocol-mismatched plans fall back to the provider-native
  credential source with a structured log, never a broken session.
- A plan-bound session validates requested models against the plan's model
  list (`validateModelAgainstPlan`), not provider catalogs.
- Composer options for a bound target replace provider-native model options
  with the plan's models (`applyModelPlanComposerOverlay`); each option carries
  the source plan name and `runtimeContext.modelPlan = {id, name, protocol}`.

## Model Switch Semantics

- Within one plan (same credential/base URL): the model change applies to the
  next call of the same session — `modelSwitch` capability, existing session
  settings update path.
- Across plans or credential sources: always a new session (the endpoint is
  fixed at session start). UI must present this as "will apply in a new
  session" and reuse the existing handoff/draft-prefill launch path; there is
  no pretend hot switch.
- Configuration changes never touch running calls; they affect the next call
  that has not started.

## Acceptance Ladder And The Fixed Review Rule

`modelpolicy` keeps a per-session acceptance ladder:
`agent_claimed → auto_checked → user_accepted`. Only an explicit user action
reaches `user_accepted` today. Automated review runs and automated ladder
advancement remain deferred; do not document or UI-promise those behaviors
until the later stack layer lands. Review runs must never close work without
the user.

Explicit in-composer “model consult” (ask another plan/model for advice from
the current session) is not a product surface: do not ship composer entry
points, runtime commands, or timeline cards for it. The composer's `@` panel
may still list enabled plan models as `workspace-model` mentions for prompt
context; that chip is presentation-only and must not imply a consult runtime.

## Migration

`model_plans_v1` backfills every legacy `managed_model_provider_credentials`
row into a named plan (`mp-migrated-<provider>`), copying the ciphertext
as-is. The WorkspaceAgent migration deterministically materializes legacy
AgentTarget bindings as `source=legacy_binding` Agents. Legacy binding rows
stay for rollback and pre-snapshot session recovery; new renderer writes are
forbidden and the migration must remain idempotent.

The retired `first_use_json` column and
`model_plan_first_use_candidates_v1` table migration remain in the SQLite
schema for downgrade compatibility. Current code does not expose, write, or
reconcile first-use state.

## Reference Protection

`DELETE /v1/workspaces/{id}/model-plans/{planId}` is blocked (409
`model_plan_referenced`) while WorkspaceAgents or legacy consumers reference the plan;
`GET .../references` lists the consumers so the UI shows impact before edits.
The resolver composes per-consumer sources (`modelbinding.Service`,
`modelpolicy.Service`, and `workspaceagent.Service`). Symmetrically,
`DELETE /v1/workspaces/{id}/model-policies/{policyId}` is blocked (409
`model_policy_referenced`) while any agent binding still references the
policy.

## What To Avoid

- Do not add a "global current model" or a second AgentTarget binding editor.
  New model selection is owned by explicit WorkspaceAgents.
- Do not surface plan credentials to the renderer, tests, or snapshots.
- Do not advertise `modelPlanBinding` for providers without a real injection
  path.
- Do not let automated review close work; the ladder tops out at
  `auto_checked` without the user.
