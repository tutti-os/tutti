import type { FusionDockVisibilityMode } from "./fusionWindowCoordinatorTypes.ts";

export type FusionDockVisibilityPreferenceAction =
  | "hide"
  | "schedule-auto-hide"
  | "show"
  | null;

export type FusionDockShortcutAction = "expand-and-show" | "hide";

export function resolveFusionDockShortcutAction(input: {
  dockSearchExpanded: boolean;
  dockVisible: boolean;
}): FusionDockShortcutAction {
  return input.dockVisible && input.dockSearchExpanded
    ? "hide"
    : "expand-and-show";
}

export function resolveFusionDockVisibilityPreferenceAction(input: {
  dockFocused: boolean;
  dockVisible: boolean;
  mode: FusionDockVisibilityMode;
}): FusionDockVisibilityPreferenceAction {
  switch (input.mode) {
    case "always":
      return "show";
    case "shortcut-only":
      return "hide";
    case "auto-hide":
      return input.dockVisible && !input.dockFocused
        ? "schedule-auto-hide"
        : null;
  }
}
