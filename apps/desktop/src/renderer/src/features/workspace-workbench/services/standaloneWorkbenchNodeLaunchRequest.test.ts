import assert from "node:assert/strict";
import test from "node:test";
import { createStandaloneWorkbenchNodeLaunchRequestController } from "./standaloneWorkbenchNodeLaunchRequest.ts";

test("standalone launch survives StrictMode setup-cleanup-setup replay", async () => {
  const controller =
    createStandaloneWorkbenchNodeLaunchRequestController<string>();
  const executions: string[] = [];
  const writes: string[] = [];
  let renderedState: "loading" | "ready" = "loading";

  const disposeFirstSetup = controller.start({
    async execute() {
      executions.push("first");
      return "first-result";
    },
    onRejected() {
      writes.push("first-error");
    },
    onResolved(result) {
      writes.push(result);
    }
  });

  // This is the effect replay performed by React StrictMode on initial mount.
  disposeFirstSetup();

  const disposeSecondSetup = controller.start({
    async execute() {
      executions.push("second");
      return "ready";
    },
    onRejected() {
      writes.push("second-error");
    },
    onResolved(result) {
      writes.push(result);
      renderedState = "ready";
    }
  });

  await flushLaunchMicrotasks();

  assert.deepEqual(executions, ["second"]);
  assert.deepEqual(writes, ["ready"]);
  assert.equal(renderedState, "ready");
  disposeSecondSetup();
});

test("standalone launch ignores a retired setup while retaining one in-flight resource", async () => {
  const controller =
    createStandaloneWorkbenchNodeLaunchRequestController<string>();
  const resolution = createDeferred<string>();
  const writes: string[] = [];
  let executionCount = 0;

  const disposeFirstSetup = controller.start({
    execute() {
      executionCount += 1;
      return resolution.promise;
    },
    onRejected() {
      writes.push("retired-error");
    },
    onResolved(result) {
      writes.push(`retired:${result}`);
    }
  });
  await flushLaunchMicrotasks();
  assert.equal(executionCount, 1);

  disposeFirstSetup();
  const disposeCurrentSetup = controller.start({
    async execute() {
      executionCount += 1;
      return "duplicate";
    },
    onRejected() {
      writes.push("current-error");
    },
    onResolved(result) {
      writes.push(`current:${result}`);
    }
  });

  resolution.resolve("ready");
  await flushLaunchMicrotasks();

  assert.equal(executionCount, 1);
  assert.deepEqual(writes, ["current:ready"]);
  disposeCurrentSetup();
});

test("standalone launch remains one-shot after its current setup settles", async () => {
  const controller =
    createStandaloneWorkbenchNodeLaunchRequestController<string>();
  let executionCount = 0;
  const writes: string[] = [];

  controller.start({
    async execute() {
      executionCount += 1;
      return "ready";
    },
    onRejected() {
      writes.push("error");
    },
    onResolved(result) {
      writes.push(result);
    }
  });
  await flushLaunchMicrotasks();

  controller.start({
    async execute() {
      executionCount += 1;
      return "duplicate";
    },
    onRejected() {
      writes.push("duplicate-error");
    },
    onResolved(result) {
      writes.push(result);
    }
  });
  await flushLaunchMicrotasks();

  assert.equal(executionCount, 1);
  assert.deepEqual(writes, ["ready"]);
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise
  };
}

async function flushLaunchMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
