import { describe, expect, it, vi } from "vitest";
import {
  AgentReviewBranchController,
  type AgentReviewBranchState
} from "./AgentReviewBranchController";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AgentReviewBranchController", () => {
  it("subscribes with the current idle state immediately", () => {
    const controller = new AgentReviewBranchController();
    const listener = vi.fn();
    controller.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      status: "idle",
      branches: [],
      currentBranch: null,
      error: null
    } satisfies AgentReviewBranchState);
  });

  it("loads branches and transitions loading -> ready", async () => {
    const deferred = createDeferred<{
      branches: readonly string[];
      currentBranch?: string | null;
    }>();
    const loader = vi.fn(() => deferred.promise);
    const controller = new AgentReviewBranchController(loader);
    const states: AgentReviewBranchState[] = [];
    controller.subscribe((state) => states.push(state));

    controller.ensureLoaded();
    expect(controller.getState().status).toBe("loading");

    deferred.resolve({ branches: ["main", "dev"], currentBranch: "dev" });
    await deferred.promise;

    expect(loader).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toEqual({
      status: "ready",
      branches: ["main", "dev"],
      currentBranch: "dev",
      error: null
    });
    expect(states.map((state) => state.status)).toEqual([
      "idle",
      "loading",
      "ready"
    ]);
  });

  it("de-duplicates concurrent ensureLoaded calls while loading", () => {
    const loader = vi.fn(
      () => createDeferred<{ branches: string[] }>().promise
    );
    const controller = new AgentReviewBranchController(loader);
    controller.ensureLoaded();
    controller.ensureLoaded();
    controller.ensureLoaded();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("serves cached branches without reloading once ready", async () => {
    const loader = vi.fn(() =>
      Promise.resolve({ branches: ["main"], currentBranch: "main" })
    );
    const controller = new AgentReviewBranchController(loader);
    controller.ensureLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getState().status).toBe("ready");

    controller.ensureLoaded();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("does not cancel an in-flight request when ensureLoaded repeats", async () => {
    const deferred = createDeferred<{ branches: readonly string[] }>();
    const loader = vi.fn(() => deferred.promise);
    const controller = new AgentReviewBranchController(loader);
    controller.ensureLoaded();
    // A second trigger (e.g. a re-render) must not discard the pending result.
    controller.ensureLoaded();

    deferred.resolve({ branches: ["main", "release"] });
    await deferred.promise;

    expect(controller.getState()).toEqual({
      status: "ready",
      branches: ["main", "release"],
      currentBranch: null,
      error: null
    });
  });

  it("resets and reloads when the loader identity changes", async () => {
    const firstLoader = vi.fn(() =>
      Promise.resolve({ branches: ["main"], currentBranch: "main" })
    );
    const controller = new AgentReviewBranchController(firstLoader);
    controller.ensureLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getState().branches).toEqual(["main"]);

    const secondLoader = vi.fn(() =>
      Promise.resolve({ branches: ["feature"], currentBranch: "feature" })
    );
    controller.setLoader(secondLoader);
    expect(controller.getState().status).toBe("idle");
    expect(controller.getState().branches).toEqual([]);

    controller.ensureLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(secondLoader).toHaveBeenCalledTimes(1);
    expect(controller.getState().branches).toEqual(["feature"]);
  });

  it("treats setLoader with the same loader as a no-op", async () => {
    const loader = vi.fn(() =>
      Promise.resolve({ branches: ["main"], currentBranch: "main" })
    );
    const controller = new AgentReviewBranchController(loader);
    controller.ensureLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getState().status).toBe("ready");

    controller.setLoader(loader);
    expect(controller.getState().status).toBe("ready");
  });

  it("discards a stale in-flight result after the loader changes", async () => {
    const stale = createDeferred<{ branches: readonly string[] }>();
    const staleLoader = vi.fn(() => stale.promise);
    const controller = new AgentReviewBranchController(staleLoader);
    controller.ensureLoaded();
    expect(controller.getState().status).toBe("loading");

    const freshLoader = vi.fn(() =>
      Promise.resolve({ branches: ["fresh"], currentBranch: "fresh" })
    );
    controller.setLoader(freshLoader);
    controller.ensureLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getState().branches).toEqual(["fresh"]);

    // The old request resolving late must not clobber the new state.
    stale.resolve({ branches: ["stale"] });
    await stale.promise;
    expect(controller.getState().branches).toEqual(["fresh"]);
  });

  it("captures load failures and allows a retry", async () => {
    const failing = createDeferred<{ branches: readonly string[] }>();
    let loader = vi.fn(() => failing.promise);
    const controller = new AgentReviewBranchController(() => loader());
    controller.ensureLoaded();
    failing.reject(new Error("git missing"));
    await failing.promise.catch(() => {});

    expect(controller.getState()).toEqual({
      status: "error",
      branches: [],
      currentBranch: null,
      error: "git missing"
    });

    loader = vi.fn(() =>
      Promise.resolve({ branches: ["main"], currentBranch: "main" })
    );
    controller.ensureLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getState().status).toBe("ready");
    expect(controller.getState().branches).toEqual(["main"]);
  });

  it("stops emitting after dispose", async () => {
    const deferred = createDeferred<{ branches: readonly string[] }>();
    const controller = new AgentReviewBranchController(() => deferred.promise);
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.ensureLoaded();
    listener.mockClear();

    controller.dispose();
    deferred.resolve({ branches: ["main"] });
    await deferred.promise;
    expect(listener).not.toHaveBeenCalled();
  });
});
