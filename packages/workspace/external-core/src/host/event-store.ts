export interface HostEventStore<TPayload> {
  subscribe(listener: (payload: TPayload) => void): () => void;
}

export function createHostEventStore<TPayload>(options: {
  consumeInitialOnce?: boolean;
  open(listener: (payload: TPayload) => void): {
    initial: Promise<TPayload | undefined>;
    unsubscribe(): void;
  };
  replayLatest: boolean;
}): HostEventStore<TPayload> {
  const listeners = new Set<(payload: TPayload) => void>();
  const buffered: TPayload[] = [];
  let hasLatest = false;
  let latest: TPayload | undefined;
  let opened = false;
  let ready = false;
  let generation = 0;
  let initialConsumed = false;
  let unsubscribeHost: (() => void) | undefined;

  function publish(payload: TPayload): void {
    latest = payload;
    hasLatest = true;
    for (const listener of listeners) {
      notifyListener(listener, payload);
    }
  }

  function ensureOpen(): void {
    if (opened) {
      return;
    }
    opened = true;
    generation += 1;
    const openedGeneration = generation;
    const stream = options.open((payload) => {
      if (openedGeneration !== generation) {
        return;
      }
      if (!ready) {
        buffered.push(payload);
        return;
      }
      publish(payload);
    });
    unsubscribeHost = stream.unsubscribe;
    void stream.initial
      .then((initial) => {
        if (openedGeneration !== generation) {
          return;
        }
        if (
          initial !== undefined &&
          (!options.consumeInitialOnce || !initialConsumed)
        ) {
          initialConsumed = true;
          publish(initial);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (openedGeneration !== generation) {
          return;
        }
        ready = true;
        for (const payload of buffered.splice(0)) {
          publish(payload);
        }
      });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (options.replayLatest && hasLatest) {
        const replay = latest as TPayload;
        queueMicrotask(() => {
          if (listeners.has(listener)) {
            notifyListener(listener, replay);
          }
        });
      }
      ensureOpen();
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeHost?.();
          unsubscribeHost = undefined;
          generation += 1;
          opened = false;
          ready = false;
          buffered.splice(0);
          hasLatest = false;
          latest = undefined;
        }
      };
    }
  };
}

function notifyListener<TPayload>(
  listener: (payload: TPayload) => void,
  payload: TPayload
): void {
  try {
    listener(payload);
  } catch {
    // App listeners are observational and must not break bridge fanout.
  }
}
