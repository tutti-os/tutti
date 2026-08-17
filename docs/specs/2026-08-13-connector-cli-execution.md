# Exact Connector CLI execution

## Goal

Products need one host-neutral primitive for executing a managed Connector CLI
without turning Connector sharing into remote shell access. The product owns
session authorization and transport; Tutti owns verified process resolution and
route lifecycle.

## Contract

`implementationhost.Host.StartCLI` accepts:

- connection ID and Connector key;
- Connector version and release digest;
- host boot epoch and generation;
- the derived managed CLI contract hash;
- bounded user arguments.

It does not accept executable paths, working directories, environment
variables, state directories, artifact roots, or arbitrary process specs. The
host resolves those values from the exact current route and rejects stale or
ambiguous identity. Route retirement fences pending starts and closes active
processes. The returned connection retains context-aware receive and graceful
stdin/terminate/kill capabilities when the underlying transport provides them;
closing it releases the route-owned process exactly once.

`host.ManagedCLIContractHash` hashes versioned invocation semantics. It excludes
entrypoint/install paths and descriptions, and includes fixed arguments,
command argument mappings, input schemas, and timeouts. Hosts publish the hash
with the immutable route descriptor and require an exact match at execution.

## Cross-machine boundary

A product that shares Connector CLI authority must define a typed Connector CLI
protocol. Across machines the protocol carries only the public Connector key,
version and command, plus bounded argv/stdin/output frames, cancellation, and a
stable operation ID. Runtime boot epoch, generation, release digest and contract
hash are machine-local identities: the receiving product resolves and pins its
own current route at execution time and passes that exact local identity to
`StartCLI`. The sharing product freezes the public CLI surface allowed by the
Owner's invocation policy and protects each route with an invocation-scoped
gateway capability. The existing authenticated invocation/command-route lease
authorizes the P2P channel; no server-side Connector CLI catalog or grant is
created. It must never accept an executable or runtime
incarnation from the peer, or reuse a broad arbitrary-command capability as the
authorization decision.

Presentation shims may expose a native command name, but a route-only shim must
dispatch to the product broker. The shim is not proof of authority. Owner is
the default; products may expose an explicit caller-authority selector, and
must fail closed on invalid values or unavailable routes without falling back
to Owner.
