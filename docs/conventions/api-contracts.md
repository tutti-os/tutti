# API Contracts

Use OpenAPI as the single source of truth for daemon HTTP contracts.

## Source Of Truth

The canonical daemon API contract lives at:

```text
services/tuttid/api/openapi/tuttid.v1.yaml
```

Generated outputs derive from that spec for:

- Go transport types and server contract code under `services/tuttid/api/generated`
- TypeScript client output under `packages/clients/tuttid-ts/src/generated`

Shared workbench snapshot schemas are the one exception inside the OpenAPI
components section. Their canonical source lives at:

```text
packages/workbench/snapshot/src/schema.json
```

The OpenAPI `WorkbenchSnapshot*` component schemas are synchronized from that
shared package so the open-source desktop and TSH can reuse the same workbench
snapshot contract while `tuttid` still exposes a normal OpenAPI transport
contract. The daemon workspace service also consumes a generated Go contract
file derived from the same shared snapshot sources for schema-version, enum,
and limit validation.

`WorkbenchSnapshot*` is an explicit shared-contract exception to the usual
"generated code stays in transport" default. When it avoids duplicate
hand-maintained mirrors, the synchronized Go snapshot contract may be reused
inside `packages/workbench/service`, with `services/tuttid/service/workspace`
consuming that shared package as a host adapter. This exception applies to the
shared workbench snapshot contract only, not to arbitrary generated request or
response DTOs.

The shared business event stream contract is the other explicit repository
exception to the HTTP OpenAPI source-of-truth rule. Its canonical sources live
at:

```text
packages/events/protocol/schemas/**/*.json
packages/events/protocol/definitions/**/*.event.json
```

Those file-based sources generate:

- TypeScript protocol contracts, validators, and topic registry metadata under
  `packages/events/protocol/src/generated`
- Go transport contracts and topic registry metadata under
  `services/tuttid/api/events/generated`

This exception is limited to the shared business event protocol boundary. The
shared package owns the schema-first event sources and the generated
TypeScript-facing protocol surface. The daemon still owns its WebSocket route,
its authoritative event catalog composition, and the generated Go transport
outputs that live under `services/tuttid/api/events/generated`.

This exception does not create a second source of truth for daemon HTTP routes
or a license to hand-maintain competing event DTOs in desktop or daemon code.

## Repository Rules

- change the OpenAPI spec before changing daemon HTTP request or response shapes
- change `packages/workbench/snapshot/src/schema.json` before changing
  `WorkbenchSnapshot*` component schemas in the OpenAPI spec
- do not hand-maintain parallel transport DTOs once the generated boundary exists
- do not hand-edit OpenAPI `WorkbenchSnapshot*` schemas; run the sync command
  instead
- do not hand-edit the daemon workbench snapshot contract constants; run the Go
  sync command instead
- do not hand-edit generated business event protocol TypeScript or Go outputs;
  run the event protocol generator instead
- do not assume generated Go structs enforce every OpenAPI or JSON Schema
  constraint at runtime
- keep generated code limited to the transport layer
- exception: the synchronized Go `WorkbenchSnapshot*` contract may be reused in
  `packages/workbench/service`, with host adapters such as
  `services/tuttid/service/workspace` consuming that shared package, because it
  is a repository-owned shared contract rather than an arbitrary route-local DTO
- exception: the shared business event protocol sources live in
  `packages/events/protocol`, while daemon-owned generated Go transport outputs
  live in `services/tuttid/api/events/generated`; keep daemon-side event-route
  orchestration, catalog composition, and business workflows hand-written
- keep business rules, orchestration, and persistence hand-written
- keep compatibility aliases such as `/healthz` out of the versioned generated client surface unless they are part of the intended public contract

## Error Contract

Daemon API failures should use the shared protocol-error shape in
`ApiErrorDetails` instead of relying on raw natural-language messages.

Rules:

- classify daemon-facing API failures through `services/tuttid/apierrors`
- treat `code` as the stable top-level contract for programmatic handling
- use `reason` to narrow copy lookup within a stable `code`
- use `params` only for structured interpolation or machine-readable context
- keep `developerMessage` diagnostic; it is not a user-facing copy contract
- use `correlationId` for cross-layer diagnostics when a request needs traceable failure context
- do not make renderer UX depend on exact `developerMessage` strings
- keep status-code mapping and transport validation at the `api` seam even when `apierrors` classifies the failure

Current canonical `ApiErrorDetails` fields are:

- `code`
- `reason`
- `params`
- `retryable`
- `developerMessage`
- `correlationId`

TypeScript consumers should normalize transport failures through
`@tutti-os/client-tuttid-ts` instead of re-inspecting raw response payloads in
each feature. Renderer and preload code may use `code`, `reason`, `params`, and
`retryable` for behavior and i18n lookup, while `developerMessage` and
`correlationId` remain diagnostic support fields.

## Resolved Defaults

When a route returns resolved defaults or effective settings, the response must
carry daemon-owned truth rather than echoing request input back to the client.

Rules:

- use explicit fields such as `effectiveSettings` for daemon-resolved values
- do not mirror request `settings` back in a response just to help clients keep
  local fallback state alive
- return `null` or omit a field when the daemon cannot resolve it
- do not synthesize fallback defaults in renderer code when the daemon leaves a
  field unresolved

`composer-options` follows this rule: request `settings` are input overrides,
while response `effectiveSettings` is the only contract for resolved homepage
composer defaults.

## Desktop Agent Conversation Detail Mode

`agentConversationDetailMode` is a global desktop preference, not a provider-specific
composer default. Keep it on the top-level desktop preferences contract and the
matching desktop preferences event payload; do not place it under
`agentComposerDefaultsByProvider`.

The stored value is the enum `coding | general`. Daemon and desktop shared
normalizers must treat missing, empty, or unknown values as `coding` so migrated
profiles keep the engineering-oriented default. `coding` does not inject extra
prompt guidance; it leaves provider defaults intact. `general` injects the
Codex-style `Non-technical UI` developer instruction section for new agent
sessions. For Codex app-server sessions, inject this through the session-scoped
Codex config before thread creation, not as a repeated per-turn
`turn/start.collaborationMode.settings.developer_instructions` override. The
same Codex session config should also include a Tutti-owned diagnostic marker
under `[tutti] conversationDetailMode = "coding" | "general"` so runtime
inspection can distinguish the global Tutti setting from Codex's own desktop
preferences. Do not confuse that with Codex collaboration mode presets: when
`collaborationMode/list` returns Default or Plan `developer_instructions`, the
Codex app-server adapter must pass the active preset instructions in
`turn/start.collaborationMode.settings.developer_instructions` so the active
mode matches Codex App behavior. Plan Mode and explicit planning-only flows
remain higher priority than conversation detail mode prompt guidance.

## Runtime Validation

OpenAPI and generated files define the transport interface, but generated Go
decoding is not a complete schema validator. In particular, ordinary struct
decoding does not reject unknown JSON fields just because a schema says
`additionalProperties: false`.

When a request schema relies on constraints that generated code does not enforce,
choose one explicit validation strategy at the `api` seam:

- configure the generated decoder or runtime to enforce the constraint
- validate the raw request body against the canonical schema before mapping it to
  generated types
- add a narrow hand-written transport validator in `api` that checks only the
  missing generated-runtime guarantees

Do not push transport-shape validation into `service`. The service interface
should receive transport-agnostic input that has already crossed the HTTP
contract seam.

For `WorkbenchSnapshot*`, transport ownership still remains in `api`: HTTP
decoding, route-specific validation strategy, and status-code mapping stay at
the API seam even when host services consume the synchronized shared snapshot
contract through `packages/workbench/service`.

Add route tests for schema constraints that matter to daemon behavior and are
not obviously enforced by the generated runtime. Examples include unknown-field
rejection, object closure, array size limits, and numeric min/max constraints.

## Tooling Rules

- run `pnpm generate:api` when the OpenAPI contract changes
- run `pnpm check:api-generated` before finishing API contract changes
- run `pnpm sync:workbench-openapi-schema` after changing the shared workbench
  snapshot schema
- run `pnpm check:workbench-openapi-schema` when you only need to check that
  the shared snapshot schema and OpenAPI component schemas are aligned
- run `pnpm sync:workbench-go-contract` after changing shared workbench snapshot
  schema or limits that daemon validation depends on
- run `pnpm check:workbench-go-contract` when you only need to check that the
  generated shared Go workbench snapshot contract is aligned with the shared
  snapshot sources
- run `pnpm generate:event-protocol` after changing shared business event
  protocol schemas or event-definition files
- run `pnpm check:event-protocol-generated` when you only need to check that
  the generated TypeScript and Go event protocol outputs are aligned with the
  shared event sources
- keep generator versions pinned in repository-managed dependencies or Go tool directives

## Scope Guidance

Generate:

- path and method contracts
- transport request and response models
- server interfaces and route glue
- shared TypeScript SDK surface

Do not generate:

- daemon business logic
- daemon persistence adapters
- Electron lifecycle code
- renderer workflows
- desktop IPC contracts that are not direct HTTP projections
