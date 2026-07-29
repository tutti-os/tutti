import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopTuttiModePlanAssignmentOptionsCache } from "./desktopTuttiModePlanAssignmentOptionsCache.ts";

test("assignment option cache refreshes directory and detail after the fresh TTL", async () => {
  let now = 0;
  let directoryLoadCount = 0;
  let detailLoadCount = 0;
  const forceValues: Array<boolean | undefined> = [];
  const cache = createDesktopTuttiModePlanAssignmentOptionsCache(
    {
      async listAgentTargets() {
        directoryLoadCount += 1;
        return {
          defaultAgentTargetId: "codex",
          targets: [
            {
              id: "codex",
              provider: "codex",
              launchRef: { type: "builtin", value: "codex" },
              name: "Codex",
              enabled: true,
              source: "system",
              sortOrder: 1,
              createdAtUnixMs: 1,
              updatedAtUnixMs: 1
            }
          ]
        } as never;
      },
      async listWorkspaceAgents() {
        return { agents: [] } as never;
      },
      async listModelPlans() {
        return { plans: [] } as never;
      }
    },
    {
      async getComposerOptions(input) {
        detailLoadCount += 1;
        forceValues.push(input.force);
        const model = `composer-2.${detailLoadCount + 4}[fast=true]`;
        return {
          provider: "cursor",
          models: [
            {
              value: model,
              label: `composer-2.${detailLoadCount + 4}`
            }
          ],
          permissionConfig: {
            configurable: true,
            modes: [{ id: "auto", label: "Auto", semantic: "auto" }]
          },
          reasoningEfforts: [{ value: "high", label: "High" }]
        } as never;
      }
    },
    () => now
  );

  const directoryInput = { workspaceId: "workspace-1" };
  await cache.source.listAgents(directoryInput);
  await cache.source.listAgents(directoryInput);
  assert.equal(directoryLoadCount, 1);

  const detailInput = {
    workspaceId: "workspace-1",
    agentTargetId: "codex"
  };
  assert.deepEqual((await cache.source.loadAgentOptions(detailInput)).models, [
    {
      value: "composer-2.5[fast=true]",
      label: "composer-2.5"
    }
  ]);
  assert.deepEqual((await cache.source.loadAgentOptions(detailInput)).models, [
    {
      value: "composer-2.5[fast=true]",
      label: "composer-2.5"
    }
  ]);
  assert.equal(detailLoadCount, 1);
  assert.deepEqual(forceValues, [undefined]);

  now = 5 * 60_000 + 1;
  await cache.source.listAgents(directoryInput);
  assert.equal(directoryLoadCount, 2);
  assert.deepEqual((await cache.source.loadAgentOptions(detailInput)).models, [
    {
      value: "composer-2.6[fast=true]",
      label: "composer-2.6"
    }
  ]);
  assert.equal(detailLoadCount, 2);
  assert.deepEqual(forceValues, [undefined, true]);
});
