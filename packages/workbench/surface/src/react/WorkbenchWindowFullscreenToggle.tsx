import { memo } from "react";
import type { WorkbenchNode } from "../core/types.ts";
import type { WorkbenchController } from "../store/types.ts";
import type { WorkbenchWindowChromeI18nRuntime } from "./workbenchWindowI18n.ts";
import { WorkbenchWindowTrafficLights } from "./WorkbenchWindowTrafficLights.tsx";

interface WorkbenchWindowFullscreenToggleProps<TData> {
  controller: WorkbenchController<TData>;
  disabled?: boolean;
  i18n: WorkbenchWindowChromeI18nRuntime;
  node: WorkbenchNode<TData>;
}

function WorkbenchWindowFullscreenToggleComponent<TData>({
  controller,
  disabled = false,
  i18n,
  node
}: WorkbenchWindowFullscreenToggleProps<TData>) {
  const isFullscreen = node.displayMode === "fullscreen";
  const label = i18n.t(isFullscreen ? "exitFullscreen" : "enterFullscreen");

  return (
    <WorkbenchWindowTrafficLights
      maximize={{
        disabled,
        label,
        onClick: (event) => {
          controller.commands.focusNode(node.id);

          if (isFullscreen) {
            controller.commands.exitFullscreen(node.id);
            return;
          }

          event.currentTarget.blur();
          controller.commands.enterFullscreen(node.id);
        },
        pressed: isFullscreen
      }}
    />
  );
}

function areWorkbenchWindowFullscreenTogglePropsEqual<TData>(
  previous: WorkbenchWindowFullscreenToggleProps<TData>,
  next: WorkbenchWindowFullscreenToggleProps<TData>
): boolean {
  return (
    previous.controller === next.controller &&
    previous.disabled === next.disabled &&
    previous.i18n === next.i18n &&
    previous.node.id === next.node.id &&
    previous.node.displayMode === next.node.displayMode
  );
}

export const WorkbenchWindowFullscreenToggle = memo(
  WorkbenchWindowFullscreenToggleComponent,
  areWorkbenchWindowFullscreenTogglePropsEqual
) as typeof WorkbenchWindowFullscreenToggleComponent;
