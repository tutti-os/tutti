import type {
  WorkbenchController,
  WorkbenchHostNodeData
} from "@tutti-os/workbench-surface";

export interface WorkspaceChromeControllerSnapshot {
  hasFullscreenWorkbenchWindow: boolean;
  hasNativeCompactTitlebar: boolean;
  lockedWorkbenchLayoutPreset: "balanced" | "row" | "column" | null;
  missionControlDisabled: boolean;
  useCompactTitlebar: boolean;
  visibleWorkbenchWindowCount: number;
}

export interface WorkspaceChromeHostLayoutAdapter {
  isNativeCompactTitlebar(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface WorkspaceChromeControllerInput {
  hostLayout: WorkspaceChromeHostLayoutAdapter;
  platform: NodeJS.Platform;
  workbenchController?: WorkbenchController<WorkbenchHostNodeData>;
}

export interface WorkspaceChromeController {
  dispose(): void;
  getSnapshot(): WorkspaceChromeControllerSnapshot;
  subscribe(listener: () => void): () => void;
  update(input: WorkspaceChromeControllerInput): void;
}

export function shouldHideWorkspaceWindowButtons(input: {
  autoHideChromeEnabled: boolean;
  hasFullscreenWorkbenchWindow: boolean;
  platform: NodeJS.Platform;
}): boolean {
  return (
    input.autoHideChromeEnabled &&
    input.hasFullscreenWorkbenchWindow &&
    input.platform === "darwin"
  );
}

export function createWorkspaceChromeController(
  input: WorkspaceChromeControllerInput
): WorkspaceChromeController {
  let currentInput = input;
  let snapshot = createSnapshot(input);
  const listeners = new Set<() => void>();
  let unsubscribeWorkbench = subscribeWorkbench(input, refreshSnapshot);
  let unsubscribeHostLayout = subscribeHostLayout(input, refreshSnapshot);

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function refreshSnapshot(): void {
    const nextSnapshot = createSnapshot(currentInput);
    if (isEqualSnapshot(snapshot, nextSnapshot)) {
      return;
    }

    snapshot = nextSnapshot;
    notify();
  }

  return {
    dispose() {
      unsubscribeWorkbench();
      unsubscribeHostLayout();
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    update(nextInput) {
      const workbenchControllerChanged =
        currentInput.workbenchController !== nextInput.workbenchController;
      const hostLayoutSubscriptionChanged =
        currentInput.hostLayout !== nextInput.hostLayout ||
        shouldSubscribeHostLayout(currentInput) !==
          shouldSubscribeHostLayout(nextInput);

      currentInput = nextInput;

      if (workbenchControllerChanged) {
        unsubscribeWorkbench();
        unsubscribeWorkbench = subscribeWorkbench(nextInput, refreshSnapshot);
      }

      if (hostLayoutSubscriptionChanged) {
        unsubscribeHostLayout();
        unsubscribeHostLayout = subscribeHostLayout(nextInput, refreshSnapshot);
      }

      refreshSnapshot();
    }
  };
}

function createSnapshot(
  input: WorkspaceChromeControllerInput
): WorkspaceChromeControllerSnapshot {
  const isDarwin = input.platform === "darwin";
  const workbenchSnapshot = input.workbenchController?.getSnapshot();
  const nodes = workbenchSnapshot?.nodes ?? [];
  const lockedWorkbenchLayoutPreset =
    workbenchSnapshot?.lockedLayout?.preset.kind ?? null;
  const visibleWorkbenchWindowCount = nodes.filter(
    (node) => !node.isMinimized
  ).length;
  const hasFullscreenWorkbenchWindow = nodes.some(
    (node) => node.displayMode === "fullscreen" && !node.isMinimized
  );
  const hasNativeCompactTitlebar =
    isDarwin && input.hostLayout.isNativeCompactTitlebar();
  const useCompactTitlebar =
    isDarwin && (hasFullscreenWorkbenchWindow || hasNativeCompactTitlebar);

  return {
    hasFullscreenWorkbenchWindow,
    hasNativeCompactTitlebar,
    lockedWorkbenchLayoutPreset,
    missionControlDisabled: visibleWorkbenchWindowCount <= 1,
    useCompactTitlebar,
    visibleWorkbenchWindowCount
  };
}

function subscribeWorkbench(
  input: WorkspaceChromeControllerInput,
  listener: () => void
): () => void {
  return input.workbenchController?.subscribe(listener) ?? noop;
}

function subscribeHostLayout(
  input: WorkspaceChromeControllerInput,
  listener: () => void
): () => void {
  if (!shouldSubscribeHostLayout(input)) {
    return noop;
  }

  return input.hostLayout.subscribe(listener);
}

function shouldSubscribeHostLayout(
  input: WorkspaceChromeControllerInput
): boolean {
  return input.platform === "darwin";
}

function isEqualSnapshot(
  left: WorkspaceChromeControllerSnapshot,
  right: WorkspaceChromeControllerSnapshot
): boolean {
  return (
    left.hasFullscreenWorkbenchWindow === right.hasFullscreenWorkbenchWindow &&
    left.hasNativeCompactTitlebar === right.hasNativeCompactTitlebar &&
    left.lockedWorkbenchLayoutPreset === right.lockedWorkbenchLayoutPreset &&
    left.missionControlDisabled === right.missionControlDisabled &&
    left.useCompactTitlebar === right.useCompactTitlebar &&
    left.visibleWorkbenchWindowCount === right.visibleWorkbenchWindowCount
  );
}

function noop(): void {
  return undefined;
}
