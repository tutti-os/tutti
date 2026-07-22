import type { WorkbenchRenderWindowHeader } from "../react/types.ts";
import type {
  WorkbenchHostNodeData,
  WorkbenchHostNodeHeaderContext
} from "./types.ts";

export function createWorkbenchHostNodeHeaderWindowActions(
  context: Parameters<WorkbenchRenderWindowHeader<WorkbenchHostNodeData>>[0],
  input: {
    requestNodeClose?: (nodeId: string) => void;
  } = {}
): WorkbenchHostNodeHeaderContext["windowActions"] {
  return {
    applyQuickLayout(target) {
      context.controller.commands.applyQuickLayout(context.node.id, target);
    },
    close() {
      if (input.requestNodeClose) {
        input.requestNodeClose(context.node.id);
        return;
      }
      context.controller.commands.closeNode(context.node.id);
    },
    focus() {
      context.controller.commands.focusNode(context.node.id);
    },
    getFrame() {
      return (
        context.controller
          .getSnapshot()
          .nodes.find((node) => node.id === context.node.id)?.frame ??
        context.node.frame
      );
    },
    minimize() {
      context.genie.minimizeNodeToAnchor(context.node.id, () =>
        context.controller.commands.minimizeNode(context.node.id)
      );
    },
    resize(frame) {
      context.controller.commands.resizeNode(context.node.id, frame);
    },
    toggleDisplayMode() {
      if (context.node.displayMode === "fullscreen") {
        context.controller.commands.exitFullscreen(context.node.id);
        return;
      }
      context.controller.commands.enterFullscreen(context.node.id);
    }
  };
}
