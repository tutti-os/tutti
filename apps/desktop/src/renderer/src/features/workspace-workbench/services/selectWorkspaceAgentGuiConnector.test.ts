import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkbenchController,
  WorkbenchHostNodeData
} from "@tutti-os/workbench-surface";
import { selectWorkspaceAgentGuiConnector } from "./selectWorkspaceAgentGuiConnector.ts";

function controllerWithNodes(
  nodes: Array<{ id: string; typeId: string }>,
  nodeStack: string[]
): WorkbenchController<WorkbenchHostNodeData> {
  return {
    dispatch: () => undefined,
    getSnapshot: () =>
      ({
        nodes: nodes.map(({ id, typeId }) => ({
          data: { instanceId: id, typeId },
          displayMode: "window",
          frame: { height: 100, width: 100, x: 0, y: 0 },
          id,
          isMinimized: false,
          kind: typeId,
          restoreFrame: null,
          title: id
        })),
        nodeStack
      }) as unknown as ReturnType<
        WorkbenchController<WorkbenchHostNodeData>["getSnapshot"]
      >,
    subscribe: () => () => undefined
  } as unknown as WorkbenchController<WorkbenchHostNodeData>;
}

test("targets the topmost existing Agent GUI node", async () => {
  const activated: unknown[] = [];
  const focused: string[] = [];
  const launched: unknown[] = [];
  const selected = await selectWorkspaceAgentGuiConnector({
    activateNode: (...args: unknown[]) => {
      activated.push(args);
    },
    connectorKey: " notion ",
    controller: controllerWithNodes(
      [
        { id: "agent-1", typeId: "agent-gui" },
        { id: "browser", typeId: "browser" },
        { id: "agent-2", typeId: "agent-gui" }
      ],
      ["agent-1", "browser", "agent-2"]
    ),
    focusNode: (nodeId) => {
      focused.push(nodeId);
    },
    launchNode: async (request) => {
      launched.push(request);
      return null;
    }
  });

  assert.equal(selected, true);
  assert.deepEqual(focused, ["agent-2"]);
  assert.deepEqual(activated, [
    [
      { nodeId: "agent-2" },
      {
        payload: { connectorKey: "notion" },
        type: "agent-gui:select-connector"
      }
    ]
  ]);
  assert.deepEqual(launched, []);
});

test("launches the unified Agent GUI when no Agent input exists", async () => {
  const launched: Array<{ payload?: unknown; typeId?: string }> = [];
  const selected = await selectWorkspaceAgentGuiConnector({
    activateNode: () => undefined,
    connectorKey: "notion",
    controller: controllerWithNodes([], []),
    focusNode: () => undefined,
    launchNode: async (request) => {
      launched.push(request);
      return "agent-new";
    }
  });

  assert.equal(selected, true);
  assert.equal(launched.length, 1);
  assert.equal(launched[0]?.typeId, "agent-gui");
  assert.deepEqual(launched[0]?.payload, {
    composerAppend: { connectorKey: "notion" }
  });
});
