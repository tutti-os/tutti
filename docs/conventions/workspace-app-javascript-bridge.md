# Workspace App JavaScript Bridge

This document defines the durable contract and ownership rules for
`window.tuttiExternal`, the privileged bridge exposed to trusted installed
Workspace Apps.

## Public Contract

`@tutti-os/workspace-external-core` is the only public contract owner. Apps
import app-safe types and helpers from:

```ts
import type { TuttiExternalBridge } from "@tutti-os/workspace-external-core/contracts";
import { isTuttiExternalOperationError } from "@tutti-os/workspace-external-core/core";
```

Hosts import the factory from the explicit host subpath:

```ts
import { createTuttiExternalBridge } from "@tutti-os/workspace-external-core/host";
```

The root entrypoint does not export host construction code.

The canonical bridge has 26 operations across these namespaces:

| Namespace      | Methods                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`          | `getContext`, `subscribe`                                                                                                                                             |
| `activity`     | `reportActive`                                                                                                                                                        |
| `browser`      | `openUrl`                                                                                                                                                             |
| `at`           | `query`                                                                                                                                                               |
| `files`        | `select`, `open`, `upload`                                                                                                                                            |
| `permissions`  | `request`                                                                                                                                                             |
| `settings`     | `open`                                                                                                                                                                |
| `workspace`    | `onLaunchIntent`, `openFeature`                                                                                                                                       |
| `references`   | `open`                                                                                                                                                                |
| `pdf`          | `printHtmlToPdf`                                                                                                                                                      |
| `userProjects` | `checkPath`, `create`, `getDefaultSelection`, `getSnapshot`, `list`, `prepareSelection`, `refresh`, `rememberDefaultSelection`, `selectDirectory`, `subscribe`, `use` |
| `logs`         | `write`                                                                                                                                                               |

## Ownership

The shared host kernel owns:

- the 26-operation roster and bridge object construction;
- user-activation policy;
- app-facing input, result, and event validation;
- structured errors and capability descriptions;
- context and user-project replay;
- initial launch-intent single consumption and future-event ordering;
- upload abort and progress-listener policy.

A product Host Adapter owns:

- Electron channel names and handled-IPC envelopes;
- the trusted guest/runtime identity;
- renderer and daemon transports;
- product UI and domain services;
- the binary upload protocol.

The host kernel must not import Electron or product modules. Product preloads
must not recreate the public method tree or copy normalizers.

## Trust Boundary

Preload validation provides consistent app behavior; it is not an authorization
boundary. Main-process or daemon handlers must validate every untrusted payload
again. `appId`, `workspaceId`, `roomId`, `installationId`, credentials, and
permission context must come from the registered host runtime, never from the
Workspace App payload.

Context isolation remains enabled, Node integration remains disabled, and the
Host Adapter itself is never exposed to the page world.

## Capabilities

New hosts expose `bridge.capabilities`; the field is optional for compatibility
with old hosts. `operations` contains only methods whose complete semantics are
implemented. Value-domain lists describe supported mention providers,
workspace features, Agent providers, and managed-AI providers.

An app running on an old host treats a missing capabilities object as unknown
and uses call/catch fallback. An app running on a new host may preflight a call,
but runtime authorization and availability can still reject it.

Promise-returning unsupported methods reject with `unsupported_operation`.
Subscription methods return unsubscribe synchronously, so an unsupported
subscription throws the same structured error synchronously.

## Errors

Public failures use `TuttiExternalOperationError` with an allowlisted code:

- `unsupported_operation`
- `invalid_input`
- `user_activation_required`
- `unauthorized`
- `unavailable`
- `operation_failed`

`hostCode` may preserve a safe product error code. Tokens, credentials,
absolute secret paths, internal stack traces, and debug messages must not cross
the guest boundary. Apps use `isTuttiExternalOperationError()` or structural
fields; they must not depend on cross-context `instanceof`.

Upload cancellation remains a DOM `AbortError`, not `operation_failed`.
`logs.write()` remains fire-and-forget and silently ignores invalid diagnostic
payloads or transport failures.

## Event Ordering

Host event streams establish their listener before resolving the initial value.
The kernel emits the initial value first and buffers later events until that
initial handshake completes. This prevents get-then-subscribe gaps and
subscribe-then-get reordering.

Launch intents are events, not state deduplicated by content. Consecutive equal
routes represent two launches. The initial launch intent is consumed once per
bridge; later intents are delivered only to active subscribers.

User-project snapshot staleness is guarded by the local stream generation and
arrival order. A business `revision` is not assumed to be globally monotonic
across host restarts unless the public contract later adds a stream identifier.

## Compatibility and Verification

Every Host Adapter must run the shared black-box conformance fixture plus its
product transport tests. Release gates cover:

- all 26 operations;
- activation, normalization, result shapes, and error mapping;
- subscription replay, ordering, listener isolation, and cleanup;
- upload abort/progress behavior;
- the complete public provider/feature value domains;
- a real context-isolated Electron page-world fixture for errors and binary
  results.

Public subpaths, package manifests, the fixed release roster, README examples,
and consumer dependency versions must be updated together.
