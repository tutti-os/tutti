export interface HostEventStore<TPayload> {
  subscribe(listener: (payload: TPayload) => void): () => void;
}

export function createHostEventStore<TPayload>(options: {
  consumeInitialOnce?: boolean;
  normalizeInitial?(payload: unknown): TPayload;
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
  let consumableInitial: Promise<TPayload | undefined> | undefined;
  let unsubscribeHost: (() => void) | undefined;

  function publish(payload: TPayload): void {
    latest = payload;
    hasLatest = true;
    for (const listener of [...listeners]) {
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
    const bufferedBeforeOpen = buffered.length;
    let initial: Promise<TPayload | undefined>;
    let closeHost: () => void;
    let rollbackHost: (() => void) | undefined;
    let retainedInitialForGeneration: Promise<TPayload | undefined> | undefined;
    try {
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
      const unsubscribe = stream.unsubscribe;
      if (typeof unsubscribe === "function") {
        rollbackHost = () => unsubscribe.call(stream);
      }
      const initialValue = stream.initial;
      if (
        !initialValue ||
        typeof initialValue.then !== "function" ||
        typeof unsubscribe !== "function"
      ) {
        throw new Error("tuttiExternal host event stream is invalid.");
      }
      const openedInitial = Promise.resolve(initialValue).then((value) => {
        if (value === undefined) {
          return undefined;
        }
        return options.normalizeInitial
          ? options.normalizeInitial(value)
          : value;
      });
      if (options.consumeInitialOnce && !initialConsumed) {
        if (!consumableInitial) {
          const retainedInitial = openedInitial;
          consumableInitial = retainedInitial;
          void retainedInitial.catch(() => {
            if (consumableInitial === retainedInitial) {
              consumableInitial = undefined;
            }
          });
        }
        retainedInitialForGeneration = consumableInitial;
        if (retainedInitialForGeneration !== openedInitial) {
          void openedInitial.catch(() => undefined);
        }
        initial = retainedInitialForGeneration.then(
          (value) => (value === undefined ? openedInitial : value),
          () => openedInitial
        );
      } else {
        initial = openedInitial;
      }
      closeHost = () => unsubscribe.call(stream);
    } catch (error) {
      if (openedGeneration === generation) {
        generation += 1;
        opened = false;
        ready = false;
        buffered.splice(bufferedBeforeOpen);
        unsubscribeHost = undefined;
      }
      try {
        rollbackHost?.();
      } catch {
        // Best-effort cleanup for a partially constructed host stream.
      }
      throw error;
    }
    unsubscribeHost = closeHost;
    const initialPromise = initial;
    void initialPromise
      .then((initial) => {
        if (openedGeneration !== generation) {
          return;
        }
        if (
          options.consumeInitialOnce &&
          consumableInitial === retainedInitialForGeneration
        ) {
          consumableInitial = undefined;
        }
        if (initial === undefined) {
          return;
        }
        if (!options.consumeInitialOnce || !initialConsumed) {
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
        notifyListener(listener, latest as TPayload);
      }
      try {
        ensureOpen();
      } catch (error) {
        listeners.delete(listener);
        throw error;
      }
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) {
          const closeHost = unsubscribeHost;
          const preservePreReadyEvents =
            options.consumeInitialOnce && !ready && buffered.length > 0;
          unsubscribeHost = undefined;
          generation += 1;
          opened = false;
          ready = false;
          if (!preservePreReadyEvents) {
            buffered.splice(0);
          }
          hasLatest = false;
          latest = undefined;
          try {
            closeHost?.();
          } catch {
            // Host cleanup is best-effort; local state is already closed.
          }
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
