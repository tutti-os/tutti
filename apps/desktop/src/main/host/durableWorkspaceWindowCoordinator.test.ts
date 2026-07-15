import assert from "node:assert/strict";
import test from "node:test";
import { createDurableWorkspaceWindowCoordinator } from "./durableWorkspaceWindowCoordinator.ts";

interface TestWindow {
  id: string;
}

test("durable workspace window coordinator reuses and activates an existing owner", async () => {
  const events: string[] = [];
  const existingWindow = { id: "existing" };
  const coordinator = createDurableWorkspaceWindowCoordinator<TestWindow>({
    activate(window) {
      events.push(`activate:${window.id}`);
    },
    find(workspaceID) {
      events.push(`find:${workspaceID}`);
      return existingWindow;
    },
    async open(workspaceID) {
      events.push(`open:${workspaceID}`);
      return { id: "opened" };
    }
  });

  assert.equal(await coordinator.show("workspace-1"), existingWindow);
  assert.deepEqual(events, ["find:workspace-1", "activate:existing"]);
});

test("durable workspace window coordinator shares one pending open per workspace", async () => {
  let resolveOpen!: (window: { id: string }) => void;
  let openCount = 0;
  const openWindow = new Promise<{ id: string }>((resolve) => {
    resolveOpen = resolve;
  });
  const coordinator = createDurableWorkspaceWindowCoordinator<TestWindow>({
    activate() {},
    find() {
      return null;
    },
    open() {
      openCount += 1;
      return openWindow;
    }
  });

  const firstShow = coordinator.show("workspace-1");
  const secondShow = coordinator.show("workspace-1");
  assert.equal(openCount, 1);

  const window = { id: "opened" };
  resolveOpen(window);
  assert.equal(await firstShow, window);
  assert.equal(await secondShow, window);
});

test("durable workspace window coordinator retries after a failed open", async () => {
  let openCount = 0;
  const coordinator = createDurableWorkspaceWindowCoordinator<TestWindow>({
    activate() {},
    find() {
      return null;
    },
    async open() {
      openCount += 1;
      if (openCount === 1) {
        throw new Error("open failed");
      }
      return { id: "recovered" };
    }
  });

  await assert.rejects(coordinator.show("workspace-1"), /open failed/);
  assert.deepEqual(await coordinator.show("workspace-1"), { id: "recovered" });
  assert.equal(openCount, 2);
});
