# Model Access Plans, Agent Model Bindings, and Model Usage Policies

Status: living architecture document for the unified model access domain.

Applies to:

- `services/tuttid/biz/modelplan`, `biz/modelbinding`, `biz/modelpolicy`, `biz/collabrun`
- `services/tuttid/service/modelplan`, `service/modelbinding`, `service/modelpolicy`, `service/collabrun`
- `services/tuttid/service/agent/model_plan_binding.go` (runtime integration)
- `packages/agent/runtimeprep/model_endpoint.go` (provider credential injection)
- The workspace settings "模型方案" surface and the AgentGUI composer model selector

## Why This Exists

Users hold fragmented model access: official subscriptions, coding plans,
domestic providers, relay gateways, and raw API keys. The product goal is to
let a user configure an access scheme once and reuse it across agents, apps,
and policies — switching models must never require duplicating an agent.

## Domain Objects

Three composable objects, all workspace-scoped:

| Object                                       | Answers                                                                                                          | Package            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------ |
| Model access plan (`modelplan.Plan`)         | "What capability do I own?" — protocol, credential, base URL, model list, detection and first-use state          | `biz/modelplan`    |
| Agent model binding (`modelbinding.Binding`) | "Which plan/model/policy does this agent target use by default?"                                                 | `biz/modelbinding` |
| Model usage policy (`modelpolicy.Policy`)    | "When and how are other models used automatically?" — execution/planning/review roles plus the fixed review rule | `biz/modelpolicy`  |

Deleting an agent target never deletes plans or policies. Multiple named plans
may share one protocol. Bindings are per `(workspaceId, agentTargetId)` so the
same target can use different plans in different workspaces.

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

Providers without a `/models` catalog (404 on every candidate) keep working:
discovery is `skipped` when manual models exist and the inference stage
becomes the authoritative credential check.

## Runtime Injection Chain

```text
agent target binding (workspace settings)
  -> agent.Service.resolveModelPlanEndpoint (Create + prepareRuntime)
  -> runtimeprep.PrepareInput.ModelEndpoint
  -> CodexPreparer: session config.toml [model_providers.tutti-model-plan] + env_key
     ClaudeCodePreparer: ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN
  -> provider runtime speaks to the plan endpoint for the whole session
```

Rules:

- Protocol compatibility is explicit: `codex`/`tutti-agent` consume `openai`
  plans, `claude-code` consumes `anthropic` plans. Cursor and OpenCode only
  reserve the `modelPlanBinding` capability; they advertise `modelSwitch` but
  receive no endpoint injection yet — no fake UI entry points.
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
`agent_claimed → auto_checked → user_accepted`. A settled turn with a
completed outcome records `agent_claimed`. When the effective policy (binding
default, overridable or disableable per session) enables the fixed
`on_task_complete` review rule, the daemon runs a policy-triggered review
consult — bounded by `MaxRunsPerSession` and `MaxTotalTokensPerSession` — and
a `VERDICT: PASS` final line raises the ladder to `auto_checked`. Only an
explicit user action reaches `user_accepted`, and only that state may close
work. Review runs land in the collaboration-run accounting and timeline like
any other consult.

## Collaboration Runs

`collabrun.Run` records every 模型咨询 (consult) / Fork / 委派 (delegate) /
Handoff with trigger source and reason, source/target sessions, actual plan
and model, context scope, status, duration, token usage, failure, and result
adoption. Consult executes daemon-side through the plan protocol client
(`modelplan.Service.Complete`) with an advisor system prompt — advice only, no
tools, ownership stays with the source session. Fork/delegate/handoff runs are
records around the existing session-create/handoff launch paths. Updates
publish on the strict-schema `agent.collaboration.updated` topic.

## Migration

`model_plans_v1` backfills every legacy `managed_model_provider_credentials`
row into a named plan (`mp-migrated-<provider>`), copying the ciphertext
as-is. Legacy tables stay for the workspace-app grant broker. Historical
sessions are untouched: bindings only affect sessions that have not started.

## Reference Protection

`DELETE /v1/workspaces/{id}/model-plans/{planId}` is blocked (409
`model_plan_referenced`) while agent bindings or policies reference the plan;
`GET .../references` lists the consumers so the UI shows impact before edits.
The resolver composes per-consumer sources (`modelbinding.Service`,
`modelpolicy.Service`).

## What To Avoid

- Do not add a "global current model" that switches every agent at once; the
  binding is per agent target.
- Do not surface plan credentials to the renderer, tests, or snapshots.
- Do not advertise `modelPlanBinding` for providers without a real injection
  path.
- Do not let automated review close work; the ladder tops out at
  `auto_checked` without the user.
