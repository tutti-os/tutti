export interface StandaloneWorkbenchNodeLaunchRequest<TResult> {
  execute(): Promise<TResult>;
  onRejected(error: unknown): void;
  onResolved(result: TResult): void;
}

export interface StandaloneWorkbenchNodeLaunchRequestController<TResult> {
  start(request: StandaloneWorkbenchNodeLaunchRequest<TResult>): () => void;
}

/**
 * Owns the one-shot asynchronous launch for a standalone workbench node.
 *
 * React StrictMode replays an effect as setup -> cleanup -> setup. Deferring
 * execution by one microtask lets the abandoned setup retire before it can
 * create a terminal, browser, or other resource. A generation then ensures
 * that only the currently mounted setup may publish the eventual result.
 *
 * If dependencies change after execution has started, the next setup attaches
 * to the same in-flight request instead of creating a duplicate resource.
 */
export function createStandaloneWorkbenchNodeLaunchRequestController<
  TResult
>(): StandaloneWorkbenchNodeLaunchRequestController<TResult> {
  let generation = 0;
  let inFlight: Promise<TResult> | null = null;
  let settled = false;

  return {
    start(request) {
      if (settled) {
        return noop;
      }

      generation += 1;
      const requestGeneration = generation;
      let active = true;
      const isCurrent = () =>
        active && !settled && requestGeneration === generation;

      void Promise.resolve().then(() => {
        if (!isCurrent()) {
          return;
        }

        inFlight ??= Promise.resolve().then(() => request.execute());
        void inFlight.then(
          (result) => {
            if (!isCurrent()) {
              return;
            }
            settled = true;
            request.onResolved(result);
          },
          (error: unknown) => {
            if (!isCurrent()) {
              return;
            }
            settled = true;
            request.onRejected(error);
          }
        );
      });

      return () => {
        active = false;
      };
    }
  };
}

function noop(): void {}
