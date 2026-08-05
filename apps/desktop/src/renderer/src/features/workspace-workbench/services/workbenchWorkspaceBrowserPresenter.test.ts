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

test("workbench Browser presenter reuses the same workspace app authorization page", async () => {
  const activations: unknown[] = [];
  const focused: string[] = [];
  const launches: unknown[] = [];
  const presenter = createWorkbenchWorkspaceBrowserPresenter({
    host: createHost({
      activations,
      focused,
      launches,
      nodes: [],
      nodeStack: []
    })
  });
  const request = {
    kind: "open" as const,
    reuseIfOpen: false,
    source: "workspace_app" as const,
    sourceNodeId: "workspace-app:99",
    url: "https://open.feishu.cn/authorization",
    workspaceId: "workspace-1"
  };

  assert.equal(await presenter(request), "browser:launched");
  assert.equal(await presenter(request), "browser:launched");

  assert.equal(launches.length, 1);
  assert.equal(activations.length, 1);
  assert.deepEqual(focused, ["browser:launched"]);
});

test("workbench Browser presenter coalesces concurrent workspace app authorization opens", async () => {
  const activations: unknown[] = [];
  const launches: unknown[] = [];
  let resolveLaunch!: (nodeId: string) => void;
  const launchResult = new Promise<string>((resolve) => {
    resolveLaunch = resolve;
  });
  const presenter = createWorkbenchWorkspaceBrowserPresenter({
    host: createHost({
      activations,
      launches,
      nodes: [],
      nodeStack: [],
      launchNode: async () => launchResult
    })
  });
  const request = {
    kind: "open" as const,
    reuseIfOpen: false,
    source: "workspace_app" as const,
    sourceNodeId: "workspace-app:99",
    url: "https://open.feishu.cn/authorization",
    workspaceId: "workspace-1"
  };

  const first = presenter(request);
  const second = presenter(request);
  assert.equal(launches.length, 1);
  resolveLaunch("browser:authorization");

  assert.deepEqual(await Promise.all([first, second]), [
    "browser:authorization",
    "browser:authorization"
  ]);
  assert.equal(launches.length, 1);
  assert.equal(activations.length, 1);
});

test("workbench Browser presenter keeps distinct workspace app URLs in separate Browsers", async () => {
  const launches: unknown[] = [];
  const launchNodeIds = ["browser:first", "browser:second"];
  const presenter = createWorkbenchWorkspaceBrowserPresenter({
    host: createHost({
      launches,
      nodes: [],
      nodeStack: [],
      launchNode: async () => launchNodeIds.shift() ?? null
    })
  });

  assert.equal(
    await presenter({
      kind: "open",
      reuseIfOpen: false,
      source: "workspace_app",
      sourceNodeId: "workspace-app:99",
      url: "https://example.com/first",
      workspaceId: "workspace-1"
    }),
    "browser:first"
  );
  assert.equal(
    await presenter({
      kind: "open",
      reuseIfOpen: false,
      source: "workspace_app",
      sourceNodeId: "workspace-app:99",
      url: "https://example.com/second",
      workspaceId: "workspace-1"
    }),
    "browser:second"
  );
  assert.equal(launches.length, 2);
});

test("workbench Browser presenter reopens an authorization page after its Browser closes", async () => {
  const launches: unknown[] = [];
  const launchNodeIds = ["browser:first", "browser:retry"];
  const nodes: Array<{ data: { typeId: string }; id: string }> = [];
  const presenter = createWorkbenchWorkspaceBrowserPresenter({
    host: createHost({
      launches,
      nodes,
      nodeStack: [],
      launchNode: async () => launchNodeIds.shift() ?? null
    })
  });
  const request = {
    kind: "open" as const,
    reuseIfOpen: false,
    source: "workspace_app" as const,
    sourceNodeId: "workspace-app:99",
    url: "https://open.feishu.cn/authorization",
    workspaceId: "workspace-1"
  };

  assert.equal(await presenter(request), "browser:first");
  nodes.splice(0);
  assert.equal(await presenter(request), "browser:retry");
  assert.equal(launches.length, 2);
});

function createHost(input: {
  activations?: unknown[];
  focused?: string[];
  launchNode?: (request: unknown) => Promise<string | null> | string | null;
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
      const nodeId = input.launchNode
        ? await input.launchNode(request)
        : "browser:launched";
      if (nodeId && !input.nodes.some((node) => node.id === nodeId)) {
        input.nodes.push({ data: { typeId: "browser" }, id: nodeId });
        input.nodeStack.push(nodeId);
      }
      return nodeId;
    }
  } as unknown as WorkbenchHostHandle;
}
