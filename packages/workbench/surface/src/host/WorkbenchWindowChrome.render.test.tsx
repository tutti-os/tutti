import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchNode } from "../core/types.ts";
import { createWorkbenchWindowChromeI18nRuntime } from "../react/workbenchWindowI18n.ts";
import { WorkbenchWindowFullscreenToggle } from "../react/WorkbenchWindowFullscreenToggle.tsx";
import { createWorkbenchController } from "../store/createWorkbenchController.ts";
import type { WorkbenchWindowActionContext } from "../react/types.ts";
import type {
  WorkbenchHostHandle,
  WorkbenchHostNodeData,
  WorkbenchHostNodeDefinition
} from "./types.ts";
import { createWorkbenchHostI18nRuntime } from "./workbenchHostI18n.ts";
import { WorkbenchHostWindowActions } from "./WorkbenchHostWindowActions.tsx";

const trafficLightsRender = vi.hoisted(() => vi.fn());

vi.mock("../react/WorkbenchWindowTrafficLights.tsx", () => ({
  WorkbenchWindowTrafficLights: (props: unknown) => {
    trafficLightsRender(props);
    return null;
  }
}));

const node: WorkbenchNode<WorkbenchHostNodeData> = {
  data: {
    instanceId: "test-1",
    typeId: "test"
  },
  displayMode: "floating",
  frame: { x: 100, y: 100, width: 320, height: 240 },
  id: "test:test-1",
  isMinimized: false,
  kind: "test",
  restoreFrame: null,
  title: "Test"
};

const movedNode: WorkbenchNode<WorkbenchHostNodeData> = {
  ...node,
  frame: { ...node.frame, x: 180, y: 160 }
};

beforeEach(() => {
  trafficLightsRender.mockClear();
});

describe("Workbench system window chrome", () => {
  it("does not render host actions again for a position-only node update", async () => {
    const controller = createWorkbenchController({
      nodes: [node],
      nodeStack: [node.id]
    });
    const genie = { minimizeNodeToAnchor: vi.fn() };
    const context: WorkbenchWindowActionContext<WorkbenchHostNodeData> = {
      controller,
      genie,
      node
    };
    const definition: WorkbenchHostNodeDefinition = {
      frame: node.frame,
      renderBody: () => null,
      title: node.title,
      typeId: node.data.typeId,
      window: { defaultOpen: true }
    };
    const nodeDefinitions = new Map([[definition.typeId, definition]]);
    const host = {
      requestNodeClose: vi.fn()
    } as unknown as WorkbenchHostHandle;
    const i18n = createWorkbenchHostI18nRuntime(undefined);
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <WorkbenchHostWindowActions
            context={context}
            host={host}
            i18n={i18n}
            nodeDefinitions={nodeDefinitions}
          />
        );
      });
      expect(trafficLightsRender).toHaveBeenCalledOnce();

      await act(async () => {
        root.render(
          <WorkbenchHostWindowActions
            context={{ ...context, node: movedNode }}
            host={host}
            i18n={i18n}
            nodeDefinitions={nodeDefinitions}
          />
        );
      });
      expect(trafficLightsRender).toHaveBeenCalledOnce();

      await act(async () => {
        root.render(
          <WorkbenchHostWindowActions
            context={{ ...context, node: movedNode }}
            host={host}
            i18n={i18n}
            nodeDefinitions={new Map(nodeDefinitions)}
          />
        );
      });
      expect(trafficLightsRender).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("does not render the fullscreen action again for a position-only node update", async () => {
    const controller = createWorkbenchController({
      nodes: [node],
      nodeStack: [node.id]
    });
    const i18n = createWorkbenchWindowChromeI18nRuntime(undefined);
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <WorkbenchWindowFullscreenToggle
            controller={controller}
            i18n={i18n}
            node={node}
          />
        );
      });
      expect(trafficLightsRender).toHaveBeenCalledOnce();

      await act(async () => {
        root.render(
          <WorkbenchWindowFullscreenToggle
            controller={controller}
            i18n={i18n}
            node={movedNode}
          />
        );
      });
      expect(trafficLightsRender).toHaveBeenCalledOnce();

      await act(async () => {
        root.render(
          <WorkbenchWindowFullscreenToggle
            controller={controller}
            i18n={i18n}
            node={{ ...movedNode, displayMode: "fullscreen" }}
          />
        );
      });
      expect(trafficLightsRender).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
