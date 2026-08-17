import { describe, expect, it } from "vitest";
import { AbortableSingleFlight } from "./abortableSingleFlight";

describe("AbortableSingleFlight", () => {
  it("shares concurrent callers for the same key", async () => {
    const pending = deferred<string>();
    const flight = new AbortableSingleFlight<string, string>();
    let starts = 0;

    const first = flight.acquire("room-1", () => {
      starts += 1;
      return pending.promise;
    });
    const second = flight.acquire("room-1", async () => {
      starts += 1;
      return "unexpected";
    });

    expect(first.shared).toBe(false);
    expect(second.shared).toBe(true);
    expect(starts).toBe(1);
    pending.resolve("ready");
    await expect(Promise.all([first.promise, second.promise])).resolves.toEqual(
      ["ready", "ready"]
    );
  });

  it("only aborts the shared operation after the final caller leaves", async () => {
    const pending = deferred<string>();
    const flight = new AbortableSingleFlight<string, string>();
    let sharedSignal: AbortSignal | undefined;
    const firstController = new AbortController();
    const secondController = new AbortController();
    const start = ({ signal }: { signal: AbortSignal }): Promise<string> => {
      sharedSignal = signal;
      return pending.promise;
    };

    const first = flight.acquire("room-1", start, firstController.signal);
    const second = flight.acquire("room-1", start, secondController.signal);
    firstController.abort();
    await expect(first.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(false);

    pending.resolve("ready");
    await expect(second.promise).resolves.toBe("ready");
  });

  it("evicts an aborted entry before an immediate retry can acquire it", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const flight = new AbortableSingleFlight<string, string>();
    const firstController = new AbortController();
    let starts = 0;

    const firstRequest = flight.acquire(
      "room-1",
      ({ signal }) => {
        starts += 1;
        signal.addEventListener(
          "abort",
          () => first.reject(new Error("aborted")),
          { once: true }
        );
        return first.promise;
      },
      firstController.signal
    );
    firstController.abort();
    await expect(firstRequest.promise).rejects.toMatchObject({
      name: "AbortError"
    });

    const retry = flight.acquire("room-1", () => {
      starts += 1;
      return second.promise;
    });
    expect(retry.shared).toBe(false);
    expect(starts).toBe(2);
    second.resolve("retry-ready");
    await expect(retry.promise).resolves.toBe("retry-ready");
  });

  it("does not let an old completion remove a replacement entry", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const flight = new AbortableSingleFlight<string, string>();
    const firstController = new AbortController();

    const firstRequest = flight.acquire(
      "room-1",
      ({ signal }) => {
        signal.addEventListener("abort", () => first.resolve("stale"), {
          once: true
        });
        return first.promise;
      },
      firstController.signal
    );
    firstController.abort();
    await expect(firstRequest.promise).rejects.toMatchObject({
      name: "AbortError"
    });

    const retry = flight.acquire("room-1", () => second.promise);
    first.resolve("late-stale");
    await Promise.resolve();
    const third = flight.acquire("room-1", () => Promise.resolve("unexpected"));
    expect(third.shared).toBe(true);
    second.resolve("fresh");
    await expect(retry.promise).resolves.toBe("fresh");
    await expect(third.promise).resolves.toBe("fresh");
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
