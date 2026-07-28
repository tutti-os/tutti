import type { WorkbenchFrame } from "@tutti-os/workbench-surface";

export function resolveDesktopAgentGUIEmbeddedDesktopSize(
  frame: Pick<WorkbenchFrame, "height" | "width">
): { height: number; width: number } {
  return {
    height: frame.height,
    width: frame.width
  };
}
