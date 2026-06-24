const wheelDeltaLinePx = 16;
const wheelDeltaPagePx = 360;
const launchpadWheelNavigationThresholdPx = 64;
const launchpadWheelNavigationCooldownMs = 420;
const launchpadWheelHorizontalIntentRatio = 1.2;

export interface WorkspaceLaunchpadWheelNavigationState {
  accumulatedDeltaX: number;
  lastNavigationAt: number;
}

export interface WorkspaceLaunchpadWheelNavigationResult {
  nextPageIndex: number | null;
  shouldPreventDefault: boolean;
  state: WorkspaceLaunchpadWheelNavigationState;
}

export function createWorkspaceLaunchpadWheelNavigationState(): WorkspaceLaunchpadWheelNavigationState {
  return {
    accumulatedDeltaX: 0,
    lastNavigationAt: 0
  };
}

export function resolveWorkspaceLaunchpadWheelNavigation(input: {
  currentPage: number;
  deltaMode?: number;
  deltaX: number;
  deltaY: number;
  pageCount: number;
  state: WorkspaceLaunchpadWheelNavigationState;
  timestamp: number;
}): WorkspaceLaunchpadWheelNavigationResult {
  if (input.pageCount <= 1) {
    return {
      nextPageIndex: null,
      shouldPreventDefault: false,
      state: createWorkspaceLaunchpadWheelNavigationState()
    };
  }

  const delta = normalizeWorkspaceLaunchpadWheelDelta(input);
  const absDeltaX = Math.abs(delta.x);
  const absDeltaY = Math.abs(delta.y);
  const isHorizontalIntent =
    absDeltaX > 0 &&
    absDeltaX >= absDeltaY * launchpadWheelHorizontalIntentRatio;

  if (!isHorizontalIntent) {
    return {
      nextPageIndex: null,
      shouldPreventDefault: false,
      state: {
        accumulatedDeltaX: 0,
        lastNavigationAt: input.state.lastNavigationAt
      }
    };
  }

  const direction = delta.x > 0 ? 1 : -1;
  const previousDirection = input.state.accumulatedDeltaX > 0 ? 1 : -1;
  const accumulatedDeltaX =
    input.state.accumulatedDeltaX !== 0 && previousDirection === direction
      ? input.state.accumulatedDeltaX + delta.x
      : delta.x;

  if (
    input.timestamp - input.state.lastNavigationAt <
    launchpadWheelNavigationCooldownMs
  ) {
    return {
      nextPageIndex: null,
      shouldPreventDefault: true,
      state: {
        accumulatedDeltaX: 0,
        lastNavigationAt: input.state.lastNavigationAt
      }
    };
  }

  if (Math.abs(accumulatedDeltaX) < launchpadWheelNavigationThresholdPx) {
    return {
      nextPageIndex: null,
      shouldPreventDefault: true,
      state: {
        accumulatedDeltaX,
        lastNavigationAt: input.state.lastNavigationAt
      }
    };
  }

  const nextPageIndex = input.currentPage + direction;
  if (nextPageIndex < 0 || nextPageIndex >= input.pageCount) {
    return {
      nextPageIndex: null,
      shouldPreventDefault: true,
      state: {
        accumulatedDeltaX: 0,
        lastNavigationAt: input.timestamp
      }
    };
  }

  return {
    nextPageIndex,
    shouldPreventDefault: true,
    state: {
      accumulatedDeltaX: 0,
      lastNavigationAt: input.timestamp
    }
  };
}

function normalizeWorkspaceLaunchpadWheelDelta(input: {
  deltaMode?: number;
  deltaX: number;
  deltaY: number;
}): { x: number; y: number } {
  const unit =
    input.deltaMode === 1
      ? wheelDeltaLinePx
      : input.deltaMode === 2
        ? wheelDeltaPagePx
        : 1;
  return {
    x: input.deltaX * unit,
    y: input.deltaY * unit
  };
}
