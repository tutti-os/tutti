import { type ReactNode } from "react";
import { WindowTrafficLightIcon } from "@tutti-os/ui-system";
import type { WorkbenchNode, WorkbenchSize } from "../core/types.ts";
import type { WorkbenchGenieController } from "./useWorkbenchGenieAnimation.tsx";
import { useWorkbenchController } from "./WorkbenchProvider.tsx";
import type { WorkbenchRenderWindowHeader } from "./types.ts";
import {
  createWorkbenchWindowChromeI18nRuntime,
  type WorkbenchWindowChromeI18nRuntime
} from "./workbenchWindowI18n.ts";

const defaultWindowChromeI18n =
  createWorkbenchWindowChromeI18nRuntime(undefined);

export function WorkbenchImmersiveChromeHeader<TData>({
  genie,
  node,
  renderWindowHeader,
  surfaceSize,
  windowChromeI18n
}: {
  genie: WorkbenchGenieController<TData>;
  node: WorkbenchNode<TData>;
  renderWindowHeader?: WorkbenchRenderWindowHeader<TData>;
  surfaceSize: WorkbenchSize;
  windowChromeI18n?: WorkbenchWindowChromeI18nRuntime;
}): ReactNode {
  const controller = useWorkbenchController<TData>();
  const resolvedI18n = windowChromeI18n ?? defaultWindowChromeI18n;
  const genieControls = {
    minimizeNodeToAnchor: (nodeID: string, minimize?: () => void) => {
      genie.minimizeNodeToAnchor(nodeID, minimize);
    }
  } as const;
  const projectedHeader = renderWindowHeader?.({
    controller,
    defaultActions: null,
    dragHandleProps: {
      "data-workbench-drag-handle": "true",
      onDoubleClick: (event) => event.stopPropagation(),
      onPointerDown: (event) => event.stopPropagation()
    },
    genie: genieControls,
    node,
    surfaceSize
  });

  return (
    <div
      className="workbench-immersive-chrome-header"
      data-workbench-immersive-chrome-header="true"
      data-workbench-window-id={node.id}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        aria-label={node.title}
        className="workbench-immersive-chrome-header__tab"
        role="group"
      >
        <button
          aria-label={resolvedI18n.t("restoreWindow")}
          className="workbench-immersive-chrome-header__tab-title"
          data-workbench-immersive-tab-restore="true"
          title={resolvedI18n.t("restoreWindow")}
          type="button"
          onClick={() => {
            controller.commands.focusNode(node.id);
            controller.commands.exitFullscreen(node.id);
          }}
        >
          <span>{node.title}</span>
        </button>
        <button
          aria-label={resolvedI18n.t("minimizeWindow")}
          className="workbench-immersive-chrome-header__tab-minimize"
          data-workbench-immersive-tab-minimize="true"
          title={resolvedI18n.t("minimizeWindow")}
          type="button"
          onClick={() => {
            controller.commands.focusNode(node.id);
            genieControls.minimizeNodeToAnchor(node.id, () =>
              controller.commands.minimizeNode(node.id)
            );
          }}
        >
          <WindowTrafficLightIcon aria-hidden iconName="close" />
        </button>
      </div>
      {projectedHeader ? (
        <div className="workbench-immersive-chrome-header__content">
          {projectedHeader}
        </div>
      ) : null}
    </div>
  );
}

export function selectVisibleFullscreenNode<TData>(state: {
  nodeStack: readonly string[];
  nodes: readonly WorkbenchNode<TData>[];
}): WorkbenchNode<TData> | null {
  const nodeById = new Map(state.nodes.map((node) => [node.id, node]));
  for (let index = state.nodeStack.length - 1; index >= 0; index -= 1) {
    const node = nodeById.get(state.nodeStack[index] ?? "");
    if (node?.displayMode === "fullscreen" && !node.isMinimized) {
      return node;
    }
  }
  return (
    state.nodes.find(
      (node) => node.displayMode === "fullscreen" && !node.isMinimized
    ) ?? null
  );
}
