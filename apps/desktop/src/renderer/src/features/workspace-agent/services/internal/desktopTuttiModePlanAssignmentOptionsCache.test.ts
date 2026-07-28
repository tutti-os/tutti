import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopTuttiModePlanAssignmentOptionsCache } from "./desktopTuttiModePlanAssignmentOptionsCache.ts";

test("assignment option cache refreshes directory and detail after the fresh TTL", async () => {
  let now = 0;
  let directoryLoadCount = 0;
  let detailLoadCount = 0;
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
      async getAgentProviderComposerOptions() {
        detailLoadCount += 1;
        const model = `gpt-${detailLoadCount}`;
        return {
          modelConfig: {
            configurable: true,
            options: [{ id: model, value: model, label: model }]
          },
          permissionConfig: {
            configurable: true,
            modes: [{ id: "auto", label: "Auto", semantic: "auto" }]
          },
          reasoningConfig: {
            configurable: true,
            options: [{ id: "high", value: "high", label: "High" }]
          }
        } as never;
      },
      async listModelPlans() {
        return { plans: [] } as never;
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
    "gpt-1"
  ]);
  assert.deepEqual((await cache.source.loadAgentOptions(detailInput)).models, [
    "gpt-1"
  ]);
  assert.equal(detailLoadCount, 1);

  now = 5 * 60_000 + 1;
  await cache.source.listAgents(directoryInput);
  assert.equal(directoryLoadCount, 2);
  assert.deepEqual((await cache.source.loadAgentOptions(detailInput)).models, [
    "gpt-2"
  ]);
  assert.equal(detailLoadCount, 2);
});
