import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import { createWorkbenchWorkspaceBrowserPresenter } from "./workbenchWorkspaceBrowserPresenter.ts";

test("workbench Browser presenter focuses the exact requested surface", async () => {
  const focused: string[] = [];
  const presenter = createWorkbenchWorkspaceBrowserPresenter({
    host: createHost({
      focused,
      nodes: [
        { data: { typeId: "browser" }, id: "browser:preferred" },
        { data: { typeId: "terminal" }, id: "terminal:one" }
      ],
      nodeStack: ["browser:preferred", "terminal:one"]
    })
  });

  assert.equal(
    await presenter({
      kind: "focus",
      preferredNodeId: "browser:preferred",
      workspaceId: "workspace-1"
    }),
    "browser:preferred"
  );
  assert.deepEqual(focused, ["browser:preferred"]);
});

test("workbench Browser presenter launches and activates a new page", async () => {
  const activations: unknown[] = [];
  const launches: unknown[] = [];
  const presenter = createWorkbenchWorkspaceBrowserPresenter({
    host: createHost({ activations, launches, nodes: [], nodeStack: [] })
  });

  assert.equal(
    await presenter({
      kind: "open",
      reuseIfOpen: false,
      source: "agent_command",
      url: "https://example.com/",
      workspaceId: "workspace-1"
    }),
    "browser:launched"
  );
  assert.deepEqual(launches, [
    {
      launchSource: "agent_command",
      reason: "host",
      typeId: "browser"
    }
  ]);
  assert.deepEqual(activations, [
    [
      { nodeId: "browser:launched" },
      {
        payload: { url: "https://example.com/" },
        type: "open-url"
      }
    ]
  ]);
});

test("workbench Browser presenter declines an exact focus when the target closed", async () => {
  const launches: unknown[] = [];
  const presenter = createWorkbenchWorkspaceBrowserPresenter({
    host: createHost({
      launches,
      nodes: [],
      nodeStack: []
    })
  });

  assert.equal(
    await presenter({
      fallbackToCurrent: false,
      kind: "focus",
      preferredNodeId: "browser:closed",
      workspaceId: "workspace-1"
    }),
    null
  );
  assert.deepEqual(launches, []);
});

function createHost(input: {
  activations?: unknown[];
  focused?: string[];
  launches?: unknown[];
  nodes: Array<{ data: { typeId: string }; id: string }>;
  nodeStack: string[];
}): WorkbenchHostHandle {
  return {
    activateNode(...args: unknown[]) {
      input.activations?.push(args);
    },
    focusNode(nodeId: string) {
      input.focused?.push(nodeId);
    },
    getSnapshot() {
      return {
        nodeStack: input.nodeStack,
        nodes: input.nodes
      };
    },
    async launchNode(request: unknown) {
      input.launches?.push(request);
      return "browser:launched";
    }
  } as unknown as WorkbenchHostHandle;
}
