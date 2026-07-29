interface DesktopAgentGUIHydrationSchedulerScope {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  requestIdleCallback?: (
    callback: IdleRequestCallback,
    options?: IdleRequestOptions
  ) => number;
  setTimeout(callback: () => void, timeout: number): number;
}

type CancelHydration = () => void;
type ScheduleHydration = (hydrate: () => void) => CancelHydration;

export function createSequentialAgentGUIHydrationScheduler(
  scope: DesktopAgentGUIHydrationSchedulerScope
): ScheduleHydration {
  let tail = Promise.resolve();

  return (hydrate) => {
    let canceled = false;
    const scheduled = tail
      .then(() => waitForIdleFrame(scope))
      .then(() => {
        if (!canceled) {
          hydrate();
        }
      });
    tail = scheduled.catch(() => {});
    return () => {
      canceled = true;
    };
  };
}

let scheduleHydration: ScheduleHydration | null = null;

export function scheduleDesktopAgentGUIWorkbenchHydration(
  hydrate: () => void
): CancelHydration {
  scheduleHydration ??= createSequentialAgentGUIHydrationScheduler(window);
  return scheduleHydration(hydrate);
}

function waitForIdleFrame(
  scope: DesktopAgentGUIHydrationSchedulerScope
): Promise<void> {
  return new Promise((resolve) => {
    const afterIdle = () => {
      scope.requestAnimationFrame(() => resolve());
    };
    if (scope.requestIdleCallback) {
      scope.requestIdleCallback(afterIdle, { timeout: 2_000 });
      return;
    }
    scope.setTimeout(afterIdle, 0);
  });
}
