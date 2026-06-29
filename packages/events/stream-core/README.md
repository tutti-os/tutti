# @tutti-os/event-stream-core

Catalog-agnostic transport core for the business event stream (daemon ↔ renderer
over WebSocket). It owns the parts that have nothing to do with a concrete event
catalog:

- connection lifecycle (`connect` / `dispose`)
- heartbeat (ping/pong) and exponential-backoff reconnect
- frame encode/decode and the subscription registry
- `connectionState` observability
- topic + scope multiplexing over a single socket

Everything catalog-specific — the concrete topics, payload validators, protocol
version/revision, and the scope axis — is **injected** via an
`EventStreamProtocol`. The core never imports a concrete catalog, so multiple
products can bind their own:

```ts
import { createEventStreamClient } from "@tutti-os/event-stream-core";

const client = createEventStreamClient<MyClientEvent, MyServerEvent, MyScope>({
  resolveUrl: () => "ws://127.0.0.1:7790/v1/events/ws",
  protocol: {
    protocolVersion,
    catalogRevision,
    assertValidClientFrame,
    assertValidServerFrame,
    createClientEvent,
    normalizeScope,
    scopeKey,
    eventMatchesScope
  }
});
```

The scope type `S` is generic: tutti binds it to `{ workspaceId }`, other products
(e.g. group chat) can bind it to `{ roomId }`. The transport is identical.
