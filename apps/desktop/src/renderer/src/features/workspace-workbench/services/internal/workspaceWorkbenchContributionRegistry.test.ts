import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkbenchCapabilityRegistry } from "@tutti-os/workbench-host";
import type { WorkbenchCapabilityFactoryDescriptor } from "@tutti-os/workbench-host";
import type { WorkbenchProductProfile } from "./workbenchProductProfile.ts";

test("workbench contribution registry sorts factories and skips unavailable entries", () => {
  const registry = resolveWorkbenchCapabilityRegistry(
    createProfile([
      createFactory({ id: "terminal", order: 40 }),
      createFactory({ id: "files", order: 10 }),
      createFactory({ id: "browser", order: 20, unavailable: true })
    ])
  );

  assert.deepEqual(
    registry.contributions.map((contribution) => contribution.id),
    ["files", "terminal"]
  );
});

test("workbench capability registry rejects duplicate factory and contribution ownership", () => {
  assert.throws(
    () =>
      resolveWorkbenchCapabilityRegistry(
        createProfile([
          createFactory({ id: "duplicate", order: 10 }),
          createFactory({ id: "duplicate", order: 20 })
        ])
      ),
    /capability factory id "duplicate" has multiple owners/
  );

  assert.throws(
    () =>
      resolveWorkbenchCapabilityRegistry(
        createProfile([
          createFactory({
            contributionId: "duplicate",
            id: "first",
            order: 10
          }),
          createFactory({
            contributionId: "duplicate",
            id: "second",
            order: 20
          })
        ])
      ),
    /contribution id "duplicate"/
  );
});

test("workbench capability registry rejects duplicate node and dock ownership", () => {
  assert.throws(
    () =>
      resolveWorkbenchCapabilityRegistry(
        createProfile([
          createFactory({ id: "first", nodeTypeId: "shared-node", order: 10 }),
          createFactory({ id: "second", nodeTypeId: "shared-node", order: 20 })
        ])
      ),
    /node type id "shared-node"/
  );

  assert.throws(
    () =>
      resolveWorkbenchCapabilityRegistry(
        createProfile([
          createFactory({ dockEntryId: "shared-dock", id: "first", order: 10 }),
          createFactory({ dockEntryId: "shared-dock", id: "second", order: 20 })
        ])
      ),
    /dock entry id "shared-dock"/
  );
});

function createFactory(input: {
  contributionId?: string;
  dockEntryId?: string;
  id: string;
  nodeTypeId?: string;
  order: number;
  unavailable?: boolean;
}): WorkbenchCapabilityFactoryDescriptor {
  return {
    id: input.id,
    order: input.order,
    create() {
      if (input.unavailable) {
        return null;
      }

      return {
        ...(input.dockEntryId
          ? { dockEntries: [{ id: input.dockEntryId } as never] }
          : {}),
        id: input.contributionId ?? input.id,
        ...(input.nodeTypeId
          ? { nodes: [{ typeId: input.nodeTypeId } as never] }
          : {})
      };
    }
  };
}

function createProfile(
  capabilityFactories: readonly WorkbenchCapabilityFactoryDescriptor[]
): WorkbenchProductProfile {
  return {
    capabilityFactories,
    productId: "test",
    scopeKind: "workspace"
  };
}
