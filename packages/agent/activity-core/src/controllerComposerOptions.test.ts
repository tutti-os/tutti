import assert from "node:assert/strict";
import test from "node:test";
import { createAgentActivityController } from "./controller.ts";
import {
  deferred,
  testAdapter,
  testComposerOptions
} from "./controller.testFixtures.ts";

test("composer options deduplicate identical inflight requests", async () => {
  const pending = deferred<ReturnType<typeof testComposerOptions>>();
  let loadCount = 0;
  const controller = createAgentActivityController({
    adapter: testAdapter({
      loadComposerOptions: async () => {
        loadCount += 1;
        return pending.promise;
      }
    }),
    workspaceId: "workspace-1"
  });

  const first = controller.loadComposerOptions({
    cwd: "/workspace",
    provider: "codex",
    targetKey: "local:codex",
    settings: { model: "model-1" }
  });
  const second = controller.loadComposerOptions({
    cwd: "/workspace",
    provider: "codex",
    targetKey: "local:codex",
    settings: { model: "model-1" }
  });
  assert.equal(
    controller.getSnapshot().composerOptionsLoadStatusByTargetKey?.[
      "local:codex"
    ],
    "loading"
  );
  pending.resolve(testComposerOptions("codex", 1));
  await Promise.all([first, second]);

  assert.equal(loadCount, 1);
  assert.equal(
    controller.getSnapshot().composerOptionsLoadStatusByTargetKey?.[
      "local:codex"
    ],
    "ready"
  );
});

test("composer options expose a terminal error state after loading fails", async () => {
  const controller = createAgentActivityController({
    adapter: testAdapter({
      loadComposerOptions: () => {
        throw new Error("composer unavailable");
      }
    }),
    workspaceId: "workspace-1"
  });

  await assert.rejects(
    controller.loadComposerOptions({
      provider: "codex",
      targetKey: "local:codex"
    }),
    /composer unavailable/
  );

  assert.equal(
    controller.getSnapshot().composerOptionsLoadStatusByTargetKey?.[
      "local:codex"
    ],
    "error"
  );
});

test("composer cache separates agent targets and request signatures", async () => {
  const requests: Array<{
    agentTargetId?: string | null;
    cwd?: string | null;
    model?: string | null;
    provider: string;
  }> = [];
  const controller = createAgentActivityController({
    adapter: testAdapter({
      loadComposerOptions: async (input) => {
        requests.push({
          agentTargetId: input.agentTargetId,
          cwd: input.cwd,
          model: input.settings?.model,
          provider: input.provider
        });
        return testComposerOptions(input.provider, requests.length);
      }
    }),
    workspaceId: "workspace-1"
  });

  await controller.loadComposerOptions({
    cwd: "/one",
    provider: "codex",
    targetKey: "local:codex",
    settings: { model: "model-1" }
  });
  await controller.loadComposerOptions({
    cwd: "/one",
    provider: "codex",
    targetKey: "local:codex",
    settings: { model: "model-1" }
  });
  await controller.loadComposerOptions({
    cwd: "/two",
    provider: "codex",
    targetKey: "local:codex",
    settings: { model: "model-1" }
  });
  await controller.loadComposerOptions({
    cwd: "/two",
    provider: "codex",
    settings: { model: "model-1" },
    targetKey: "target-1"
  });
  await controller.loadComposerOptions({
    cwd: "/two",
    provider: "codex",
    settings: { model: "model-1" },
    targetKey: "target-2"
  });
  await controller.loadComposerOptions({
    cwd: "/two",
    provider: "codex",
    settings: { model: "model-2" },
    targetKey: "target-1"
  });

  assert.equal(requests.length, 5);
  assert.deepEqual(
    requests.map((request) => request.agentTargetId ?? "provider"),
    ["local:codex", "local:codex", "target-1", "target-2", "target-1"]
  );
});

test("composer force and invalidation bypass settled cache entries", async () => {
  let loadCount = 0;
  const controller = createAgentActivityController({
    adapter: testAdapter({
      loadComposerOptions: async (input) => {
        loadCount += 1;
        return testComposerOptions(input.provider, loadCount);
      }
    }),
    workspaceId: "workspace-1"
  });
  const request = { provider: "codex", targetKey: "local:codex" } as const;

  await controller.loadComposerOptions(request);
  await controller.loadComposerOptions(request);
  await controller.loadComposerOptions({ ...request, force: true });
  controller.invalidateComposerOptions({ providers: ["codex"] });
  await controller.loadComposerOptions(request);

  assert.equal(loadCount, 3);
});
