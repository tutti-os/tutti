import type { AppUpdateState } from "@shared/contracts/ipc";
import type { AppUpdateViewState } from "../services/appUpdateTypes";

export type StandaloneAppUpdateStatusPresentation =
  | {
      actionKey: NonNullable<AppUpdateViewState["actionKey"]>;
      kind: "action";
      titleKey: NonNullable<AppUpdateViewState["titleKey"]>;
      titleParams: AppUpdateViewState["titleParams"];
    }
  | {
      kind: "status";
      titleKey: NonNullable<AppUpdateViewState["titleKey"]>;
      titleParams: AppUpdateViewState["titleParams"];
    };

export function resolveStandaloneAppUpdateStatusPresentation(
  view: AppUpdateViewState
): StandaloneAppUpdateStatusPresentation | null {
  if (!view.visible || !view.titleKey || view.tone === "error") {
    return null;
  }

  if (view.action && view.actionKey) {
    return {
      actionKey: view.actionKey,
      kind: "action",
      titleKey: view.titleKey,
      titleParams: view.titleParams
    };
  }

  return {
    kind: "status",
    titleKey: view.titleKey,
    titleParams: view.titleParams
  };
}

export function shouldShowReleaseNotesAction(
  channel: AppUpdateState["channel"] | null | undefined,
  action: AppUpdateViewState["action"]
): boolean {
  return (
    channel === "stable" && (action === "download" || action === "install")
  );
}
