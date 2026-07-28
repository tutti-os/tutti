# Agent Activity Tuttid Adapter

Monorepo-private, platform-neutral mapping between the generated tuttid
workspace-agent DTOs and the canonical `@tutti-os/agent-activity-core`
entities.

Application hosts continue to own transport, lifecycle, logging, storage, and
command execution. This package intentionally contains no React, DOM, Electron,
or React Native dependencies.

It also owns the single `agentActivityComposerOptionsFromTuttidResult` mapper
for the daemon Composer-options response. Hosts execute the request through
their engine command port, then feed this canonical activity-core projection
back to the engine; they do not duplicate provider capability parsing. The
public mapper accepts the generated `AgentProviderComposerOptionsResponse`
contract. Only its documented `runtimeContext` remains opaque; typed Skill and
capability catalogs do not grow compatibility fields in this adapter.

`agentActivitySessionDetailFromTuttid` is the single detail aggregate mapper for
Desktop and Mobile. It validates and maps the root Session, nested child
Sessions, and Turns as one value. The caller supplies the requested Session id;
the mapper rejects a mismatched response root, a child outside that hierarchy,
or a Turn not owned by the requested Session. A host dispatches the result
through one `session/detailSnapshotReceived` intent; it must not partially
publish a root when a child or Turn violates the generated protocol contract.
Transport reads, message paging, retries, and Engine dispatch remain in the host
adapter.
