export class DeviceLinkAttemptWake {
  private readonly versions = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();

  version(attemptId: string): number {
    return this.versions.get(attemptId) ?? 0;
  }

  notify(attemptId: string): void {
    if (!attemptId.trim()) return;
    this.versions.set(attemptId, this.version(attemptId) + 1);
    for (const resolve of this.waiters.get(attemptId) ?? []) resolve();
    this.waiters.delete(attemptId);
  }

  wait(
    attemptId: string,
    afterVersion: number,
    signal: AbortSignal
  ): Promise<boolean> {
    if (this.version(attemptId) > afterVersion) return Promise.resolve(true);
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      const finish = (notified: boolean) => {
        signal.removeEventListener("abort", onAbort);
        const waiters = this.waiters.get(attemptId);
        waiters?.delete(finishResolve);
        if (waiters && waiters.size === 0) this.waiters.delete(attemptId);
        resolve(notified);
      };
      const finishResolve = () => finish(true);
      const onAbort = () => finish(false);
      const waiters = this.waiters.get(attemptId) ?? new Set<() => void>();
      waiters.add(finishResolve);
      this.waiters.set(attemptId, waiters);
      signal.addEventListener("abort", onAbort, { once: true });
      if (this.version(attemptId) > afterVersion) finish(true);
    });
  }
}
