import type { WorkbenchNode } from "../core/types.ts";
import type { WorkbenchController } from "../store/types.ts";
import type { WorkbenchWindowChromeI18nRuntime } from "./workbenchWindowI18n.ts";
import { WorkbenchWindowTrafficLights } from "./WorkbenchWindowTrafficLights.tsx";

export function WorkbenchWindowFullscreenToggle<TData>({
  controller,
  disabled = false,
  i18n,
  node
}: {
  controller: WorkbenchController<TData>;
  disabled?: boolean;
  i18n: WorkbenchWindowChromeI18nRuntime;
  node: WorkbenchNode<TData>;
}) {
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
