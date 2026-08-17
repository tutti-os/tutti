import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import { createWorkbenchWorkspaceBrowserPresenter } from "./workbenchWorkspaceBrowserPresenter.ts";

test("workbench Browser presenter focuses the exact requested surface", async () => {
  const focused: string[] = [];
  const presenter = createWorkbenchWorkspaceBrowserPresenter({
    browserPages: createBrowserPages(),
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
    browserPages: createBrowserPages(),
    host: createHost({
      activations,
      launches,
      nodes: [{ data: { typeId: "browser" }, id: "browser:existing" }],
      nodeStack: ["browser:existing"]
    })
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

test("workbench Browser presenter activates an existing page by URL", async () => {
  const activations: unknown[] = [];
  const focused: string[] = [];
  const openRequests: unknown[] = [];
  const presenter = createWorkbenchWorkspaceBrowserPresenter({
    browserPages: createBrowserPages({
      openPage(request) {
        openRequests.push(request);
        return {
          pageNodeId: "browser:older:tab:1",
          surfaceNodeId: "browser:older"
        };
      }
    }),
    host: createHost({
      activations,
      focused,
      nodes: [
        { data: { typeId: "browser" }, id: "browser:older" },
        { data: { typeId: "browser" }, id: "browser:recent" }
      ],
      nodeStack: ["browser:older", "browser:recent"]
    })
  });

  assert.equal(
    await presenter({
      kind: "open",
      url: "https://example.com/a",
      workspaceId: "workspace-1"
    }),
    "browser:older"
  );
  assert.deepEqual(openRequests, [
    {
      surfaceNodeIds: ["browser:recent", "browser:older"],
      url: "https://example.com/a",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(focused, ["browser:older"]);
  assert.deepEqual(activations, []);
});

test("workbench Browser presenter launches a new surface when existing tab state is unavailable", async () => {
  const activations: unknown[] = [];
  const launches: unknown[] = [];
  const presenter = createWorkbenchWorkspaceBrowserPresenter({
    browserPages: createBrowserPages(),
    host: createHost({
      activations,
      launches,
      nodes: [{ data: { typeId: "browser" }, id: "browser:unavailable" }],
      nodeStack: ["browser:unavailable"]
    })
  });

  assert.equal(
    await presenter({
      kind: "open",
      url: "https://example.com/b",
      workspaceId: "workspace-1"
    }),
    "browser:launched"
  );
  assert.deepEqual(launches, [
    {
      launchSource: undefined,
      reason: "host",
      typeId: "browser"
    }
  ]);
  assert.deepEqual(activations, [
    [
      { nodeId: "browser:launched" },
      {
        payload: { url: "https://example.com/b" },
        type: "open-url"
      }
    ]
  ]);
});

test("workbench Browser presenter opens a missing URL as a tab in the current surface", async () => {
  const activations: unknown[] = [];
  const focused: string[] = [];
  const presenter = createWorkbenchWorkspaceBrowserPresenter({
    browserPages: createBrowserPages({
      openPage() {
        return {
          pageNodeId: "browser:recent:tab:2",
          surfaceNodeId: "browser:recent"
        };
      }
    }),
    host: createHost({
      activations,
      focused,
      nodes: [{ data: { typeId: "browser" }, id: "browser:recent" }],
      nodeStack: ["browser:recent"]
    })
  });

  assert.equal(
    await presenter({
      kind: "open",
      url: "https://example.com/b",
      workspaceId: "workspace-1"
    }),
    "browser:recent"
  );
  assert.deepEqual(focused, ["browser:recent"]);
  assert.deepEqual(activations, []);
});

function createBrowserPages(
  overrides: {
    openPage?: (request: unknown) => {
      pageNodeId: string;
      surfaceNodeId: string;
    } | null;
  } = {}
) {
  return {
    openPage: overrides.openPage ?? (() => null)
  };
}

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
