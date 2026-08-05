export interface SuccessfulRaceTask<T> {
  name: string;
  run: () => Promise<T | null>;
}

export interface SuccessfulRaceResult<T> {
  name: string;
  value: T;
}

/**
 * Resolves with the first non-null task result while treating individual
 * failures as losing paths. Every task receives a rejection handler, so a
 * loser that finishes after the winner cannot create an unhandled rejection.
 */
export function raceSuccessful<T>(
  tasks: readonly SuccessfulRaceTask<T>[]
): Promise<SuccessfulRaceResult<T>> {
  if (tasks.length === 0) {
    return Promise.reject(
      new Error("connection race requires at least one path")
    );
  }
  return new Promise((resolve, reject) => {
    let remaining = tasks.length;
    let settled = false;
    let lastError: Error | null = null;
    for (const task of tasks) {
      Promise.resolve()
        .then(task.run)
        .then(
          (value) => {
            if (settled) return;
            if (value !== null) {
              settled = true;
              resolve({ name: task.name, value });
              return;
            }
            remaining -= 1;
            if (remaining === 0) {
              settled = true;
              reject(lastError ?? new Error("all connection paths failed"));
            }
          },
          (error: unknown) => {
            if (settled) return;
            lastError = toError(error);
            remaining -= 1;
            if (remaining === 0) {
              settled = true;
              reject(lastError);
            }
          }
        );
    }
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
