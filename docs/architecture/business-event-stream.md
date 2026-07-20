# Business Event Stream

Status: current implemented architecture

This document describes the shared business event stream between desktop
clients, `tuttid`, and extensible feature surfaces.

The event stream is a business transport, not an Electron host bridge and not a
replacement for every existing WebSocket route.

## Design Goals

- provide one general-purpose business event stream for bidirectional product
  coordination
- keep one schema-first source of truth for shared event contracts
- let reusable packages consume typed business events without owning WebSocket
  details
- support extension-owned event fragments without collapsing into
  untyped `unknown` payloads

## Non-Goals

- do not fold the workspace terminal transport into the business event stream
- do not route Electron-only or OS-only capabilities through the event stream
- do not expose raw daemon-internal domain models as transport contracts
- do not allow arbitrary ad hoc JSON payloads without a declared contract

## Why This Exists

`tuttid` and desktop clients use this stream for bidirectional coordination that
ordinary request-response APIs do not handle well.

We want one durable event model that:

- gives business features a shared stream instead of many route-local
  pub-sub shapes
- keeps contract ownership out of any single host implementation because both
  client and server may participate in the stream contract
- preserves strong types and runtime validation across Go and TypeScript

## Transport Boundary

Business events use a dedicated managed loopback WebSocket route, separate from
ordinary HTTP APIs and separate from terminal streaming.

Current transport split:

- HTTP request-response for ordinary daemon business APIs
- dedicated terminal WebSocket for terminal-specific stream semantics
- dedicated business-event WebSocket for typed business events

Desktop still follows the normal backend-access rule:

- `renderer -> tuttid` for business APIs and business streams
- `renderer -> preload -> main` for host capabilities

`main` supervises the managed daemon endpoint and issues the bearer token, but
it does not become a general event relay.

## Shared Contract Ownership

The business event contract belongs to a repository-owned shared package under
`packages/`, not to `services/tuttid` alone and not to `apps/desktop` alone.

That shared package owns:

- event-definition source files
- protocol-core JSON Schemas
- generated TypeScript transport contracts, validators, and topic registry
  metadata

The daemon transport seam owns:

- generated Go transport contracts and registry output under
  `services/tuttid/api/events/generated`
- the authoritative catalog used by `/v1/events/ws`
- daemon-side route validation, session handling, and subscription fan-out

The shared package must not own:

- concrete WebSocket connection management
- Electron preload or IPC code
- daemon-owned generated Go outputs
- daemon business orchestration
- renderer feature state or UI behavior

## Event Definition Model

Each event is defined by one file that combines protocol metadata with a
payload JSON Schema.

The event-definition source is the only shared source of truth.

Example shape:

```json
{
  "$schema": "https://tutti.dev/schemas/event-definition.schema.json",
  "topic": "workspace.issue.updated",
  "version": 1,
  "direction": "server->client",
  "owner": "core",
  "scope": "workspace",
  "payloadSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["workspaceId", "issue"],
    "properties": {
      "workspaceId": {
        "type": "string",
        "minLength": 1
      },
      "issue": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "title", "status"],
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "title": { "type": "string" },
          "status": {
            "type": "string",
            "enum": ["todo", "in_progress", "done"]
          }
        }
      }
    }
  }
}
```

Required metadata fields:

- `topic`
- `version`
- `direction`
- `owner`
- `scope`
- `payloadSchema`

## Scope Modules

`scope` names the event-center module that owns routing semantics for the topic.
It is not a free-form feature tag and it is not a reason to create another local
event bus.

Current scope modules:

- `global`: product-wide business events that are not bound to a desktop
  runtime instance or a workspace
- `desktop`: desktop-instance events such as desktop preferences or runtime
  settings
- `workspace`: workspace-bound events that require workspace context in the
  envelope

Workspace app center runtime and installation state uses the workspace scope.
The `workspace.app.updated` server event carries one complete app projection in
`payload.app`; the workspace id stays in the envelope scope. The app projection
also carries a per-`workspaceId + appId` `stateRevision`. HTTP app snapshots are
authoritative and may replace local app state directly. WebSocket app events are
incremental and clients should apply them only when the event revision is newer
than the local app revision.

When adding a business event, choose one of these modules before introducing new
transport infrastructure. If the event is product-wide, define it as
`scope: "global"` in the shared event catalog instead of creating a separate
"global events" socket, renderer store, daemon pub-sub route, or package-local
event center.

Add a new scope module only when the existing modules cannot model the routing
contract. A new scope is a protocol change: update the shared schema first,
regenerate the TypeScript and Go outputs, and keep daemon route orchestration in
the existing business-event stream.

## Envelope Model

The event envelope is protocol-owned and shared across all topics.

Each event route-specific payload lives under `payload`; protocol metadata such
as `id`, `topic`, and timestamp are not redefined inside each topic schema.

Current envelope shape:

```ts
type EventEnvelope<TTopic extends string, TPayload> = {
  id: string;
  topic: TTopic;
  version: number;
  emittedAt: string;
  scope?: {
    workspaceId?: string;
  };
  payload: TPayload;
};
```

Scope stays in the envelope rather than being duplicated as an ordinary payload
field for every workspace-scoped topic.

## Event Authority

`tuttid` remains the single business core for authoritative domain workflows
and domain-state changes.

That means:

- client-to-server event publishing represents typed request or intent topics
- `tuttid` validates and executes those intents through its normal business
  authority
- authoritative domain-state events are emitted by `tuttid`

Desktop clients may publish intents onto the stream, but they do not become a
second business core by publishing final business-state events directly.

## Control Frames

The business event socket uses a small transport-level frame set. The frame set
is intentionally generic so business features work in terms of typed events
instead of raw WebSocket payload juggling.

Core client-to-server frames:

- `subscribe`
- `unsubscribe`
- `publish`
- `ping`

Core server-to-client frames:

- `ready`
- `ack`
- `event`
- `error`
- `pong`

The business socket protocol should stay narrow and reusable. Terminal-specific
frames such as resize or byte-stream input stay on the terminal transport.

`publish` is transport for typed client intents
and extension-owned request topics, not as a shortcut around daemon business
authority.

## Catalog And Fragment Composition

The shared event package organizes definitions as one composed catalog
assembled from domain-local fragments.

Current source layout:

```text
packages/events/protocol/
  definitions/
    agent/
    analytics/
    preferences/
    workspace/
  schemas/
    core/
    topics/
```

Rules:

- each topic belongs to exactly one fragment
- fragments are composed into one authoritative daemon-served catalog for the
  event route
- `topic + version` must be unique across the composed catalog
- each topic has exactly one producer side, expressed through `direction`
- clients consume the resulting catalog contract instead of inventing
  host-specific competing catalogs

This keeps the protocol open for growth without turning into one central file or
many incompatible local event models.

## Code Generation

Event-definition files generate:

- TypeScript payload and envelope types in `packages/events/protocol`
- TypeScript runtime validators and topic registry metadata in
  `packages/events/protocol`
- Go payload and envelope transport types in
  `services/tuttid/api/events/generated`
- Go topic registry metadata in `services/tuttid/api/events/generated`

Those generated outputs belong first to the stream transport seam. They must
not turn into many hand-maintained parallel TypeScript interfaces or Go structs
for the same event payload once the shared generated contract exists.

The current daemon implementation keeps authoritative catalog composition,
payload validation strategy, and intent orchestration in daemon-owned code. The
shared package provides the schema-first source files and generated metadata the
daemon transport seam builds on; it does not replace daemon route ownership.

Only one conversion should exist at the publish boundary:

- daemon or client internal model -> shared event contract

Transport adapters publish and consume the generated event DTOs. Business logic
should map once at the publish or subscribe seam instead of treating transport
DTOs as daemon-internal domain models.

## Package Integration

Reusable business packages should not open sockets directly.

Instead, they should consume a typed event-source abstraction backed by the
shared catalog:

- transport adapters own WebSocket lifecycle, authentication, reconnect, and
  frame handling
- business packages own topic-local reducers, projections, and workflows
- package code depends on generated transport contracts plus a typed event
  source, not on desktop runtime globals or daemon-specific socket setup

This keeps transport host-specific while making business event handling
reusable.

## Extension Model

Future extension-owned features may contribute additional event fragments.

Those fragments become active only through registration into the authoritative
daemon-served catalog for the route.

Extension events must still follow the shared protocol rules:

- use an extension namespace such as `ext.<extension-id>.*`
- declare `direction`
- declare `version`
- declare `scope`
- provide a payload JSON Schema

The protocol stays open to new fragments, but not open to untyped payloads.

## Evolution Rules

- keep the envelope stable and shared across topics
- use `version` as a field, not as part of the topic name
- breaking payload changes require a new event version
- prefer additive evolution for non-breaking payload growth
- keep `additionalProperties` explicit for payload objects that should stay
  closed
- do not reuse the same topic name for both directions

## Relationship To Other Contracts

The business event stream contract is separate from daemon HTTP OpenAPI.

- OpenAPI remains the single source of truth for daemon HTTP request-response
  contracts
- event-definition files remain the single source of truth for the business
  event stream contract

This separation keeps HTTP routes and bidirectional event contracts explicit
instead of forcing one toolchain to model both transport families.

It is also separate from [Agent Event Subscriptions](./agent-event-subscriptions.md).
The business event stream wakes connected observers and carries typed UI or
app projections; it is not a durable orchestration queue. Agent subscriptions
match canonical facts and persist delivery before a Host worker creates a
continuation turn. A future event-stream topic may expose that state, but a
WebSocket publish or reconnect can never be the delivery authority.
