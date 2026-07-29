import assert from "node:assert/strict";
import test from "node:test";
import { createSequentialAgentGUIHydrationScheduler } from "./desktopAgentGUIWorkbenchHydration.ts";

test("hydrates restored AgentGUI bodies one idle frame at a time", async () => {
  const idleCallbacks: IdleRequestCallback[] = [];
  const frameCallbacks: FrameRequestCallback[] = [];
  const hydrated: string[] = [];
  const schedule = createSequentialAgentGUIHydrationScheduler({
    requestAnimationFrame(callback) {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    },
    requestIdleCallback(callback) {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    },
    setTimeout() {
      throw new Error("idle callback fallback should not run");
    }
  });

  schedule(() => hydrated.push("first"));
  schedule(() => hydrated.push("second"));
  await Promise.resolve();

  assert.equal(idleCallbacks.length, 1);
  idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 10 });
  frameCallbacks.shift()?.(0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(hydrated, ["first"]);
  assert.equal(idleCallbacks.length, 1);

  idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 10 });
  frameCallbacks.shift()?.(16);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(hydrated, ["first", "second"]);
});

test("skips canceled AgentGUI body hydration", async () => {
  const frameCallbacks: FrameRequestCallback[] = [];
  const schedule = createSequentialAgentGUIHydrationScheduler({
    requestAnimationFrame(callback) {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    },
    setTimeout(callback) {
      callback();
      return 1;
    }
  });
  let hydrated = false;
  const cancel = schedule(() => {
    hydrated = true;
  });
  cancel();
  await Promise.resolve();
  frameCallbacks.shift()?.(0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(hydrated, false);
});
