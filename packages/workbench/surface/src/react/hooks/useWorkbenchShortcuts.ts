import { useEffect } from "react";
import { selectFocusedVisibleWorkbenchNode } from "../../core/selectors.ts";
import { useWorkbenchController } from "../WorkbenchProvider.tsx";
import {
  resolveWorkbenchShortcutIntent,
  type WorkbenchWindowManagementShortcutPreset
} from "./workbenchShortcutIntent.ts";

export function useWorkbenchShortcuts<TData = unknown>(
  options: {
    enabled?: boolean;
    windowManagementShortcutPreset?: WorkbenchWindowManagementShortcutPreset | null;
  } = {}
): void {
  const controller = useWorkbenchController<TData>();
  const enabled = options.enabled ?? true;
  const windowManagementShortcutPreset =
    options.windowManagementShortcutPreset ?? null;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const intent = resolveWorkbenchShortcutIntent(event, {
        windowManagementShortcutPreset
      });
      if (!intent) {
        return;
      }

      let handled = false;
      const snapshot = controller.getSnapshot();
      const focusedNode = selectFocusedVisibleWorkbenchNode(snapshot);
      const isLockedFocusedNode =
        focusedNode !== null &&
        (snapshot.lockedLayout?.nodeIDs.includes(focusedNode.id) ?? false);
      if (intent.type === "exitFullscreen") {
        if (focusedNode?.displayMode === "fullscreen") {
          controller.commands.exitFullscreen(focusedNode.id);
          handled = true;
        }
      } else if (intent.type === "applyFocusedSnapTarget") {
        if (focusedNode) {
          // With a locked layout, snapping shortcuts move the focused window
          // between the locked grid slots instead of snapping it to an edge.
          const lockedDirection = isLockedFocusedNode
            ? resolveLockedMoveDirection(intent.snapTarget)
            : null;
          if (lockedDirection) {
            controller.commands.moveLockedNode(focusedNode.id, lockedDirection);
          } else {
            controller.commands.applySnapTarget(
              focusedNode.id,
              intent.snapTarget
            );
          }
          handled = true;
        }
      } else if (intent.type === "applyFocusedQuickLayout") {
        if (focusedNode) {
          const lockedDirection = isLockedFocusedNode
            ? resolveLockedMoveDirection(intent.target)
            : null;
          if (lockedDirection) {
            controller.commands.moveLockedNode(focusedNode.id, lockedDirection);
          } else {
            controller.commands.applyQuickLayout(focusedNode.id, intent.target);
          }
          handled = true;
        }
      } else {
        controller.commands.applyVisibleLayoutPreset(intent.preset);
        handled = true;
      }

      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [controller, enabled, windowManagementShortcutPreset]);
}

function resolveLockedMoveDirection(
  target: string
): "left" | "right" | "up" | "down" | null {
  switch (target) {
    case "left":
      return "left";
    case "right":
      return "right";
    case "top":
      return "up";
    case "bottom":
      return "down";
    default:
      return null;
  }
}
