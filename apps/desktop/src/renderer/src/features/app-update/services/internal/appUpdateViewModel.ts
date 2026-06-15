import type { AppUpdateState } from "@shared/contracts/ipc";
import type { AppUpdateViewState } from "../appUpdateTypes";

const hiddenStatuses = new Set([
  "disabled",
  "error",
  "idle",
  "unsupported",
  "up_to_date"
]);

export function resolveAppUpdateViewState(
  state: AppUpdateState | null,
  isActing = false
): AppUpdateViewState {
  const hiddenView = createHiddenView(isActing);
  if (!state || hiddenStatuses.has(state.status)) {
    return hiddenView;
  }

  if (state.status === "checking") {
    return {
      ...hiddenView,
      busy: true,
      icon: "loading",
      titleKey: "updates.checkingTitle",
      visible: true
    };
  }

  if (state.status === "available") {
    return {
      ...hiddenView,
      action: "download",
      actionKey: "updates.downloadAction",
      busy: isActing,
      icon: isActing ? "loading" : "spark",
      titleKey: "updates.availableTitle",
      visible: true
    };
  }

  if (state.status === "downloading") {
    const progressPercent = normalizePercent(state.downloadPercent);
    return {
      ...hiddenView,
      busy: true,
      icon: "loading",
      progressPercent,
      titleKey: "updates.downloadingTitle",
      titleParams: {
        percent: formatPercent(progressPercent)
      },
      visible: true
    };
  }

  if (state.status === "downloaded") {
    return {
      ...hiddenView,
      action: "install",
      actionKey: "updates.restartAction",
      busy: isActing,
      icon: isActing ? "loading" : "spark",
      titleKey: "updates.downloadedTitle",
      visible: true
    };
  }

  return {
    ...hiddenView,
    action: "retry",
    actionKey: "updates.retryAction",
    busy: isActing,
    icon: isActing ? "loading" : "alert",
    titleKey: "updates.errorTitle",
    tone: "error",
    visible: true
  };
}

function createHiddenView(isActing: boolean): AppUpdateViewState {
  return {
    action: null,
    actionKey: null,
    busy: isActing,
    icon: isActing ? "loading" : "spark",
    progressPercent: null,
    titleKey: null,
    tone: "info",
    visible: false
  };
}

function normalizePercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatPercent(value: number | null): string {
  return value === null ? "" : `${value}%`;
}
