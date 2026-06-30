---
"@tutti-os/event-stream-core": minor
---

Extract the catalog-agnostic event-stream transport core into a publishable
package. The connection lifecycle, heartbeat, backoff reconnect, frame
encode/decode and subscription registry now live in `@tutti-os/event-stream-core`,
generic over the client/server event and scope types and parameterized by an
injected `EventStreamProtocol`. `@tutti-os/client-tuttid-ts` keeps its public
`createTuttidEventStreamClient` surface unchanged and becomes a thin tutti
binding (workspace `scope.workspaceId`) on top of the core.
