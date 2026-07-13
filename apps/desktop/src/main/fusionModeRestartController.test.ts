import assert from "node:assert/strict";
import test from "node:test";
import { createFusionModeRestartController } from "./fusionModeRestartController.ts";

test("Fusion mode restart controller prompts once for a dismissed target until the preference returns", async () => {
  const prompts: boolean[] = [];
  const controller = createFusionModeRestartController({
    currentProcessModeActive: false,
    prompt(targetModeActive) {
      prompts.push(targetModeActive);
      return Promise.resolve("later");
    },
    readPersistedMode: async () => true,
    restart() {}
  });

  controller.observePersistedMode(true);
  await flushAsyncWork();
  controller.observePersistedMode(true);
  await flushAsyncWork();
  assert.deepEqual(prompts, [true]);

  controller.observePersistedMode(false);
  controller.observePersistedMode(true);
  await flushAsyncWork();
  assert.deepEqual(prompts, [true, true]);
});

test("Fusion mode restart controller keeps only one prompt in flight", async () => {
  const prompt = createDeferred<"later" | "restart">();
  let promptCalls = 0;
  const controller = createFusionModeRestartController({
    currentProcessModeActive: false,
    prompt() {
      promptCalls += 1;
      return prompt.promise;
    },
    readPersistedMode: async () => true,
    restart() {}
  });

  controller.observePersistedMode(true);
  controller.observePersistedMode(true);
  assert.equal(promptCalls, 1);

  prompt.resolve("later");
  await flushAsyncWork();
  assert.equal(promptCalls, 1);
});

test("Fusion mode restart controller rechecks persisted mode before restarting", async () => {
  const events: string[] = [];
  const controller = createFusionModeRestartController({
    currentProcessModeActive: false,
    prompt: async () => {
      events.push("prompt");
      return "restart";
    },
    readPersistedMode: async () => {
      events.push("read");
      return false;
    },
    restart() {
      events.push("restart");
    }
  });

  controller.observePersistedMode(true);
  await flushAsyncWork();

  assert.deepEqual(events, ["prompt", "read"]);
});

test("Fusion mode restart controller restarts only after a mismatching persisted recheck", async () => {
  const events: string[] = [];
  const controller = createFusionModeRestartController({
    currentProcessModeActive: true,
    prompt: async (targetModeActive) => {
      events.push(`prompt:${String(targetModeActive)}`);
      return "restart";
    },
    readPersistedMode: async () => {
      events.push("read");
      return false;
    },
    restart() {
      events.push("restart");
    }
  });

  controller.observePersistedMode(false);
  await flushAsyncWork();

  assert.deepEqual(events, ["prompt:false", "read", "restart"]);
});

test("Fusion mode restart controller ignores pending prompt results after disposal", async () => {
  const prompt = createDeferred<"later" | "restart">();
  let persistedReads = 0;
  let restarts = 0;
  const controller = createFusionModeRestartController({
    currentProcessModeActive: false,
    prompt: () => prompt.promise,
    readPersistedMode: async () => {
      persistedReads += 1;
      return true;
    },
    restart() {
      restarts += 1;
    }
  });

  controller.observePersistedMode(true);
  controller.dispose();
  prompt.resolve("restart");
  await flushAsyncWork();

  assert.equal(persistedReads, 0);
  assert.equal(restarts, 0);
});

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise(value)
  };
}
