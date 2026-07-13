import assert from "node:assert/strict";
import test from "node:test";
import { FusionWindowRegistry } from "./fusionWindowRegistry.ts";

test("FusionWindowRegistry resolves the most recently focused reusable window", () => {
  let now = 100;
  let id = 0;
  const registry = new FusionWindowRegistry({
    createID: () => `window-${++id}`,
    now: () => ++now
  });
  const first = registry.create({
    kind: "browser",
    workspaceId: "workspace-1"
  });
  const second = registry.create({
    kind: "browser",
    workspaceId: "workspace-1"
  });
  registry.markFocused(first.windowInstanceId);

  assert.equal(
    registry.findReusable({ kind: "browser", workspaceId: "workspace-1" })
      ?.windowInstanceId,
    first.windowInstanceId
  );
  assert.equal(
    registry.findReusable({
      forceNew: true,
      kind: "browser",
      workspaceId: "workspace-1"
    }),
    null
  );
  assert.equal(
    registry.list().at(-1)?.windowInstanceId,
    second.windowInstanceId
  );
});

test("FusionWindowRegistry matches a requested background resource exactly", () => {
  let id = 0;
  const registry = new FusionWindowRegistry({
    createID: () => `window-${++id}`,
    now: () => id
  });
  registry.create({
    kind: "agent",
    resourceId: "session-a",
    workspaceId: "workspace-1"
  });
  const sessionB = registry.create({
    kind: "agent",
    resourceId: "session-b",
    workspaceId: "workspace-1"
  });

  assert.equal(
    registry.findReusable({
      kind: "agent",
      resourceId: "session-b",
      workspaceId: "workspace-1"
    })?.windowInstanceId,
    sessionB.windowInstanceId
  );
});

test("FusionWindowRegistry removes closed native windows independently of resource lifetime", () => {
  let id = 0;
  const registry = new FusionWindowRegistry({
    createID: () => `window-${++id}`,
    now: () => id
  });
  const agent = registry.create({
    kind: "agent",
    resourceId: "session-a",
    workspaceId: "workspace-1"
  });
  assert.equal(registry.remove(agent.windowInstanceId), agent);
  assert.equal(registry.find(agent.windowInstanceId), null);
});

test("FusionWindowRegistry updates resource and title metadata", () => {
  const registry = new FusionWindowRegistry({
    createID: () => "window-1",
    now: () => 100
  });
  const window = registry.create({
    kind: "terminal",
    workspaceId: "workspace-1"
  });

  const updated = registry.update({
    resourceId: "terminal-1",
    title: "Build",
    windowInstanceId: window.windowInstanceId
  });

  assert.equal(updated?.resourceId, "terminal-1");
  assert.equal(updated?.title, "Build");
});

test("FusionWindowRegistry projects native windows within one workspace boundary", () => {
  let id = 0;
  const registry = new FusionWindowRegistry({
    createID: () => `window-${++id}`,
    now: () => id
  });
  const workspaceA = registry.create({
    kind: "browser",
    workspaceId: "workspace-a"
  });
  registry.create({ kind: "terminal", workspaceId: "workspace-b" });

  assert.equal(registry.list().length, 2);
  assert.deepEqual(registry.listForWorkspace("workspace-a"), [workspaceA]);
});
