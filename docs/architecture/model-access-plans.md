# Model Access Plans

Model access plans are daemon-owned, per-workspace configurations for routing
supported agent runtimes through a named model endpoint. A plan owns its wire
protocol, endpoint, encrypted credential, model catalog, default model,
detection state, enabled state, and first-successful-use state.

This slice owns plans and per-agent-target bindings. A separate staged layer,
`services/tuttid/service/modelpolicy`, adds model-usage policies (role-to-plan
mappings, per-session overrides, and a session acceptance record) and registers
those policies as plan consumers for the deletion protection below. Binding and
policy links are validated in both directions: a binding may reference only a
model-usage policy that exists in the same workspace, and a policy cannot be
deleted while any agent binding references it — deletion is rejected with a 409
until those bindings are cleared or rebound. The daemon does not yet execute a
policy's role map or its fixed review rule: review automation and automated
acceptance advancement remain deferred to a later stack layer, so only the
explicit user-acceptance endpoint moves the acceptance ladder today. This slice
does not define workspace-app plan consumers.

## Ownership

- `services/tuttid/biz/modelplan` and `modelbinding` own the product models and
  validation.
- `services/tuttid/data/workspace` owns plan and binding persistence.
- `services/tuttid/service/modelplan` owns CRUD, staged endpoint detection,
  deletion protection, and first-use projection state.
- `services/tuttid/service/modelbinding` owns target-to-plan validation and
  reference listing. A binding is accepted only when the target provider
  declares model-plan support for the plan's protocol.
- `packages/agent/daemon/providerregistry` declares whether a provider runtime
  accepts a model-plan endpoint and which protocol it consumes.
- `packages/agent/runtimeprep` contains the provider-specific endpoint
  adapters. Codex and Tutti Agent receive a session-scoped Codex provider
  configuration; Claude Code receives its supported environment contract.
- `services/tuttid/service/agent` is an adapter: it resolves the workspace
  binding, supplies the endpoint to runtime preparation, and projects the
  first completed turn back to the plan service. It does not change session or
  Turn lifecycle semantics owned by `packages/agent/host`.

Provider support is fail-closed. A provider may advertise
`modelPlanBinding` only when its registry descriptor declares a protocol and a
matching runtime-preparation adapter exists. OpenCode and Cursor currently keep
their provider-native credential sources.

## Request And Runtime Flow

1. A client creates and detects a plan through the OpenAPI-defined daemon
   routes.
2. The client binds an agent target to that plan and, optionally, one model
   from the plan catalog.
3. Before a new session starts, the tuttid agent adapter resolves the binding
   and validates an explicitly requested model against the plan catalog.
4. Runtime preparation injects the endpoint and credential only into the
   session-scoped provider environment/configuration. Credentials are never
   returned by the API or written into generated instructions and manifests.
5. Before Host starts the provider runtime, tuttid durably records the
   session-to-plan attribution. After the first completed runtime turn, tuttid
   records the plan's first-use projection and removes that attribution.
   Failed turns do not complete it. Startup reconciliation replays any
   attribution whose completed canonical turn was committed before an
   observer failure or process shutdown.

Disabling a plan prevents new sessions from using it; existing running
sessions are not interrupted. Deleting a plan is rejected while any consumer
still references it: agent target bindings and model-usage policies both
count. The references API returns `agent_target` and `model_policy` entries,
each carrying the consumer's role (bindings report `default`; policies report
`execution`, `planning`, or `review`). Symmetrically, deleting a model-usage
policy is rejected while any agent binding still references it; rebind or clear
those bindings first.

## Rollout Gate

Model plan and agent-binding write routes require the device-global
`lab.modelPlans` preference. Reads and previously established runtime bindings
continue to work when the flag is off. Missing or unreadable preferences fail
closed for writes.
