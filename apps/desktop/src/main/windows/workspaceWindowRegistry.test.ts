import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceWindowRegistry } from "./workspaceWindowRegistry.ts";

interface TestWindow {
  destroyed: boolean;
  id: string;
  isDestroyed(): boolean;
}

test("workspace window registry allows only one durable window per workspace", () => {
  const registry = new WorkspaceWindowRegistry<TestWindow>();
  const firstWindow = createWindow("first");
  const secondWindow = createWindow("second");

  registry.register(firstWindow, {
    kind: "workspace",
    workspaceID: "workspace-1"
  });

  assert.equal(
    registry.findWorkspaceWindow("workspace-1", "workspace"),
    firstWindow
  );
  assert.throws(
    () =>
      registry.register(secondWindow, {
        kind: "workspace",
        workspaceID: "workspace-1"
      }),
    /already has a durable workspace window/
  );
});

test("workspace window registry permits auxiliary agent windows", () => {
  const registry = new WorkspaceWindowRegistry<TestWindow>();
  const firstAgentWindow = createWindow("agent-1");
  const secondAgentWindow = createWindow("agent-2");

  registry.register(firstAgentWindow, {
    kind: "agent",
    workspaceID: "workspace-1"
  });
  registry.register(secondAgentWindow, {
    kind: "agent",
    workspaceID: "workspace-1"
  });

  assert.equal(
    registry.findWorkspaceWindow("workspace-1", "agent"),
    firstAgentWindow
  );
});

test("workspace window registry releases destroyed durable owners", () => {
  const registry = new WorkspaceWindowRegistry<TestWindow>();
  const firstWindow = createWindow("first");
  const secondWindow = createWindow("second");
  registry.register(firstWindow, {
    kind: "workspace",
    workspaceID: "workspace-1"
  });

  firstWindow.destroyed = true;
  registry.register(secondWindow, {
    kind: "workspace",
    workspaceID: "workspace-1"
  });

  assert.equal(
    registry.findWorkspaceWindow("workspace-1", "workspace"),
    secondWindow
  );
});

function createWindow(id: string): TestWindow {
  return {
    destroyed: false,
    id,
    isDestroyed() {
      return this.destroyed;
    }
  };
}
