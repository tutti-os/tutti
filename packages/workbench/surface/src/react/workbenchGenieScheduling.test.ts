import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveNativeFirstGenieTexture,
  scheduleWorkbenchGeniePostAnimationIdleTask,
  scheduleWorkbenchGenieWarmup,
  startCachedWorkbenchGenieRestore
} from "./workbenchGenieScheduling.ts";

test("launches only after the cached genie animation settles", async () => {
  const events: string[] = [];
  const tasks: (() => void)[] = [];
  let settleAnimation = () => {};

  startCachedWorkbenchGenieRestore({
    launch: () => events.push("launch"),
    onLaunchSettled: () => events.push("reveal"),
    scheduleTask: (callback) => {
      tasks.push(callback);
    },
    startAnimation: (onAnimationSettled) => {
      events.push("animation");
      settleAnimation = onAnimationSettled;
    }
  });

  assert.deepEqual(events, ["animation"]);
  assert.equal(tasks.length, 0);
  settleAnimation();
  settleAnimation();
  assert.deepEqual(events, ["animation"]);
  assert.equal(tasks.length, 1);
  tasks.shift()?.();
  assert.deepEqual(events, ["animation", "launch"]);
  await Promise.resolve();
  assert.deepEqual(events, ["animation", "launch", "reveal"]);
});

test("warms once even when the genie canvas was used before idle time", () => {
  const callbacks: (() => void)[] = [];
  let animationActive = true;
  let warmupComplete = false;
  let warmupCalls = 0;

  const cancel = scheduleWorkbenchGenieWarmup({
    isAnimationActive: () => animationActive,
    isWarmupComplete: () => warmupComplete,
    renderWarmup: () => {
      warmupCalls += 1;
      warmupComplete = true;
    },
    scheduler: {
      cancelIdleCallback() {},
      requestIdleCallback: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      }
    }
  });

  callbacks.shift()?.();
  assert.equal(warmupCalls, 0);
  assert.equal(callbacks.length, 1);

  animationActive = false;
  callbacks.shift()?.();
  assert.equal(warmupCalls, 1);
  assert.equal(callbacks.length, 0);

  cancel();
});

test("cancels a pending genie warmup", () => {
  const callbacks: (() => void)[] = [];
  const cancelledIdleIDs: number[] = [];
  let warmupCalls = 0;

  const cancel = scheduleWorkbenchGenieWarmup({
    isAnimationActive: () => false,
    isWarmupComplete: () => false,
    renderWarmup: () => {
      warmupCalls += 1;
    },
    scheduler: {
      cancelIdleCallback: (idleID) => {
        cancelledIdleIDs.push(idleID);
      },
      requestIdleCallback: (callback) => {
        callbacks.push(callback);
        return 41;
      }
    }
  });

  cancel();
  callbacks.shift()?.();

  assert.deepEqual(cancelledIdleIDs, [41]);
  assert.equal(warmupCalls, 0);
});

test("defers a late texture task until an animation settles and the browser is idle", () => {
  const callbacks: (() => void)[] = [];
  let animationActive = true;
  let taskCalls = 0;

  scheduleWorkbenchGeniePostAnimationIdleTask({
    isAnimationActive: () => animationActive,
    isCancelled: () => false,
    runTask: () => {
      taskCalls += 1;
    },
    scheduler: {
      cancelIdleCallback() {},
      requestIdleCallback: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      }
    }
  });

  callbacks.shift()?.();
  assert.equal(taskCalls, 0);
  assert.equal(callbacks.length, 1);

  animationActive = false;
  callbacks.shift()?.();
  assert.equal(taskCalls, 1);
  assert.equal(callbacks.length, 0);
});

test("drops a stale late texture task without decoding it", () => {
  const callbacks: (() => void)[] = [];
  let taskCalls = 0;

  scheduleWorkbenchGeniePostAnimationIdleTask({
    isAnimationActive: () => false,
    isCancelled: () => true,
    runTask: () => {
      taskCalls += 1;
    },
    scheduler: {
      cancelIdleCallback() {},
      requestIdleCallback: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      }
    }
  });

  callbacks.shift()?.();
  assert.equal(taskCalls, 0);
});

test("does not prepare the DOM fallback when native capture renders", async () => {
  let domFallbackCalls = 0;
  const result = await resolveNativeFirstGenieTexture({
    nativeImageUrlPromise: Promise.resolve("data:image/png;base64,native"),
    renderDomFallback: () => {
      domFallbackCalls += 1;
      return "dom";
    },
    renderNativeImage: () => "native",
    timeoutMs: 120
  });

  assert.equal(result.texture, "native");
  assert.equal(result.nativeStatus, "resolved");
  assert.equal(domFallbackCalls, 0);
});

test("uses the DOM fallback when a native image cannot supply a genie texture", async () => {
  let domFallbackCalls = 0;
  const result = await resolveNativeFirstGenieTexture({
    nativeImageUrlPromise: Promise.resolve(
      "data:image/png;base64,dock-thumbnail"
    ),
    renderDomFallback: () => {
      domFallbackCalls += 1;
      return "full-resolution-dom";
    },
    renderNativeImage: () => null,
    timeoutMs: 120
  });

  assert.equal(result.texture, "full-resolution-dom");
  assert.equal(result.nativeStatus, "resolved");
  assert.equal(domFallbackCalls, 1);
});

test("prepares the DOM fallback after native failure or timeout", async () => {
  let failureFallbackCalls = 0;
  const failed = await resolveNativeFirstGenieTexture({
    nativeImageUrlPromise: Promise.reject(new Error("capture failed")),
    renderDomFallback: () => {
      failureFallbackCalls += 1;
      return "dom-after-failure";
    },
    renderNativeImage: () => "native",
    timeoutMs: 120
  });

  let timeoutFallbackCalls = 0;
  const timedOut = await resolveNativeFirstGenieTexture({
    nativeImageUrlPromise: new Promise(() => {}),
    renderDomFallback: () => {
      timeoutFallbackCalls += 1;
      return "dom-after-timeout";
    },
    renderNativeImage: () => "native",
    timeoutMs: 0
  });

  assert.equal(failed.texture, "dom-after-failure");
  assert.equal(failed.nativeStatus, "resolved");
  assert.equal(failureFallbackCalls, 1);
  assert.equal(timedOut.texture, "dom-after-timeout");
  assert.equal(timedOut.nativeStatus, "pending");
  assert.equal(timeoutFallbackCalls, 1);
});
