# @tutti-os/workbench-host

Product-neutral Workbench coordinator and disposable session lifecycle for
renderer hosts.

The package owns renderer-local session indexing, immutable partition
replacement, lease disposal, stable host-input publication, surface attachment
handoff, and deterministic capability ownership checks. It does not own React,
Electron, product transport clients, authentication discovery, or product
business policy.

## Runtime API

```ts
import {
  createWorkbenchHostSessionConfiguration,
  WorkbenchHostCoordinator,
  WorkbenchHostSession
} from "@tutti-os/workbench-host";

const configuration = createWorkbenchHostSessionConfiguration({
  createSession: (partition) =>
    new WorkbenchHostSession({
      partition,
      resolve: (update: string) => ({
        hostInput: { value: update },
        state: update
      })
    })
});

const coordinator = new WorkbenchHostCoordinator();
const lease = coordinator.open({
  configuration,
  partition: {
    scope: { id: "workspace-1", kind: "workspace" }
  }
});

lease.session.update("ready");
lease.release();
coordinator.dispose();
```

Create one coordinator per renderer/window dependency-injection root. Product
DI tokens and registration stay in the product renderer. Separate renderer
coordinators never share sessions, and renderer isolation does not grant a
second durable snapshot writer.

## Conformance

The `@tutti-os/workbench-host/conformance` subpath exposes runner-neutral test
cases. Consumers can register the same cases in Node test, Vitest, or another
test runner and may supply their DI-resolved coordinator, partition mapping, and
capability profile fixture.

```ts
import { test } from "node:test";
import { createWorkbenchHostConformanceCases } from "@tutti-os/workbench-host/conformance";

for (const conformanceCase of createWorkbenchHostConformanceCases()) {
  test(conformanceCase.name, conformanceCase.run);
}
```

The shared cases cover the public kernel contract. Product repositories and
composition roots must add their own durable-writer, metadata preservation,
snapshot restore, and transport isolation cases.
