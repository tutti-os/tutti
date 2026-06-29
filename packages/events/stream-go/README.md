# streamgo (github.com/tutti-os/tutti/packages/events/stream-go)

Catalog-agnostic **server-side** core for the business event stream
(daemon ↔ renderer over WebSocket). The Go counterpart to
`@tutti-os/event-stream-core`.

It owns the in-memory pub/sub registry, scope routing and session fan-out:

- `Service[S comparable]` — sessions, subscriptions, scoped publish/fan-out
- `Session[S]` — per-connection outbound event channel
- the catalog **contract** (`Catalog`, `Direction`, `ValidationError`, …)

It is generic over the scope type `S` and depends only on an injected `Catalog`
(minimal: `TopicVersion` / `ValidatePublish` / `ValidateSubscription`) plus a
`ScopeNormalizer[S]`. It contains **no concrete topics**. Each product binds its
own scope and catalog:

- tutti workspace → `Service[EventScope]` where `EventScope = { WorkspaceID }`
- group chat → `Service[RoomScope]` where `RoomScope = { RoomID }`

The WS frame encode/decode (which is woven through the generated protocol types)
stays in each product's API layer and calls this registry.
