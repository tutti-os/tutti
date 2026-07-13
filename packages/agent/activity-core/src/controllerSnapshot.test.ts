import assert from "node:assert/strict";
import test from "node:test";
import { createAgentActivityController } from "./controller.ts";
import { testAdapter, testSession } from "./controller.testFixtures.ts";

test("stale session load and upsert cannot regress the canonical entity", async () => {
  const stale = testSession({ title: "Stale", updatedAtUnixMs: 10 });
  const controller = createAgentActivityController({
    adapter: testAdapter({
      listSessions: async () => ({ sessions: [stale] })
    }),
    workspaceId: "workspace-1"
  });
  controller.upsertSession(
    testSession({ title: "Current", updatedAtUnixMs: 20 })
  );

  const beforeLoad = controller.getSnapshot();
  await controller.load();
  assert.equal(controller.getSnapshot().sessions[0]?.title, "Current");
  assert.equal(controller.getSnapshot(), beforeLoad);

  controller.upsertSession(stale);
  assert.equal(controller.getSnapshot().sessions[0]?.title, "Current");
  assert.equal(controller.getSnapshot(), beforeLoad);
});

test("equivalent loads and upserts preserve snapshot identity", async () => {
  const canonical = testSession({
    settings: { model: "model-1", planMode: false },
    updatedAtUnixMs: 20
  });
  const controller = createAgentActivityController({
    adapter: testAdapter({
      listSessions: async () => ({
        sessions: [
          testSession({
            settings: canonical.settings,
            updatedAtUnixMs: 20
          })
        ]
      })
    }),
    workspaceId: "workspace-1"
  });
  controller.upsertSession(canonical);
  const initial = controller.getSnapshot();

  await controller.load();
  assert.equal(controller.getSnapshot(), initial);
  controller.upsertSession({
    ...canonical,
    settings: { ...canonical.settings }
  });
  assert.equal(controller.getSnapshot(), initial);
});
