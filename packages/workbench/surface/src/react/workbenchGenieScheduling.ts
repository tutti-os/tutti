export interface CachedWorkbenchGenieRestoreInput {
  launch(): Promise<unknown> | unknown;
  onLaunchSettled(): void;
  scheduleTask(callback: () => void): void;
  startAnimation(onAnimationSettled: () => void): void;
}

export function startCachedWorkbenchGenieRestore({
  launch,
  onLaunchSettled,
  scheduleTask,
  startAnimation
}: CachedWorkbenchGenieRestoreInput): void {
  let launchScheduled = false;
  const launchAfterAnimation = () => {
    if (launchScheduled) {
      return;
    }
    launchScheduled = true;
    scheduleTask(() => {
      void Promise.resolve(launch()).then(onLaunchSettled, onLaunchSettled);
    });
  };

  startAnimation(launchAfterAnimation);
}

export interface WorkbenchGenieIdleScheduler {
  cancelIdleCallback(idleID: number): void;
  requestIdleCallback(callback: () => void): number;
}

export function scheduleWorkbenchGenieWarmup({
  isAnimationActive,
  isWarmupComplete,
  renderWarmup,
  scheduler
}: {
  isAnimationActive(): boolean;
  isWarmupComplete(): boolean;
  renderWarmup(): void;
  scheduler: WorkbenchGenieIdleScheduler;
}): () => void {
  let cancelled = false;
  let idleID: number | null = null;

  const schedule = () => {
    idleID = scheduler.requestIdleCallback(runWarmup);
  };
  const runWarmup = () => {
    idleID = null;
    if (cancelled || isWarmupComplete()) {
      return;
    }
    if (isAnimationActive()) {
      schedule();
      return;
    }
    renderWarmup();
  };

  schedule();
  return () => {
    cancelled = true;
    if (idleID !== null) {
      scheduler.cancelIdleCallback(idleID);
    }
  };
}

export function scheduleWorkbenchGeniePostAnimationIdleTask({
  isAnimationActive,
  isCancelled,
  runTask,
  scheduler
}: {
  isAnimationActive(): boolean;
  isCancelled(): boolean;
  runTask(): void;
  scheduler: WorkbenchGenieIdleScheduler;
}): () => void {
  let cancelled = false;
  let idleID: number | null = null;

  const schedule = () => {
    idleID = scheduler.requestIdleCallback(run);
  };
  const run = () => {
    idleID = null;
    if (cancelled || isCancelled()) {
      return;
    }
    if (isAnimationActive()) {
      schedule();
      return;
    }
    runTask();
  };

  schedule();
  return () => {
    cancelled = true;
    if (idleID !== null) {
      scheduler.cancelIdleCallback(idleID);
    }
  };
}

export interface NativeFirstGenieTextureResult<TTexture> {
  nativeImageUrl: string | null;
  nativeStatus: "pending" | "resolved";
  texture: TTexture | null;
}

export async function resolveNativeFirstGenieTexture<TTexture>({
  nativeImageUrlPromise,
  renderDomFallback,
  renderNativeImage,
  timeoutMs
}: {
  nativeImageUrlPromise: Promise<string | null>;
  renderDomFallback(): Promise<TTexture | null> | TTexture | null;
  renderNativeImage(
    nativeImageUrl: string
  ): Promise<TTexture | null> | TTexture | null;
  timeoutMs: number;
}): Promise<NativeFirstGenieTextureResult<TTexture>> {
  const nativeCapture = await new Promise<{
    nativeImageUrl: string | null;
    nativeStatus: "pending" | "resolved";
  }>((resolve) => {
    let settled = false;
    const settleResolved = (nativeImageUrl: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ nativeImageUrl, nativeStatus: "resolved" });
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ nativeImageUrl: null, nativeStatus: "pending" });
    }, timeoutMs);
    nativeImageUrlPromise.then(settleResolved, () => settleResolved(null));
  });

  const nativeTexture = nativeCapture.nativeImageUrl
    ? await Promise.resolve(
        renderNativeImage(nativeCapture.nativeImageUrl)
      ).catch(() => null)
    : null;
  const texture =
    nativeTexture ??
    (await Promise.resolve(renderDomFallback()).catch(() => null));

  return {
    ...nativeCapture,
    texture
  };
}
