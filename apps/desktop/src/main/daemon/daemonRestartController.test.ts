import assert from "node:assert/strict";
import test from "node:test";
import {
  createDaemonRestartController,
  type DaemonRestartLogger
} from "./daemonRestartController.ts";

function silentLogger(): DaemonRestartLogger {
  return { info() {}, warn() {}, error() {} };
}

const config = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 5,
  healthyResetMs: 30_000
};

test("restarts the daemon once after an unexpected exit", async () => {
  let restartCount = 0;
  const delays: number[] = [];
  const controller = createDaemonRestartController({
    restart: async () => {
      restartCount += 1;
    },
    isStopRequested: () => false,
    delay: async (ms) => {
      delays.push(ms);
    },
    now: () => 0,
    logger: silentLogger(),
    config
  });

  const recovered = await controller.notifyExited();

  assert.equal(restartCount, 1);
  assert.deepEqual(delays, [500]);
  assert.equal(recovered, true);
});

test("does not restart when stop was requested", async () => {
  let restartCount = 0;
  const controller = createDaemonRestartController({
    restart: async () => {
      restartCount += 1;
    },
    isStopRequested: () => true,
    delay: async () => {},
    now: () => 0,
    logger: silentLogger(),
    config
  });

  const recovered = await controller.notifyExited();

  assert.equal(restartCount, 0);
  assert.equal(recovered, false);
});

test("uses exponential backoff and gives up after max attempts", async () => {
  let restartCount = 0;
  const delays: number[] = [];
  const errors: string[] = [];
  const controller = createDaemonRestartController({
    restart: async () => {
      restartCount += 1;
      throw new Error("boom");
    },
    isStopRequested: () => false,
    delay: async (ms) => {
      delays.push(ms);
    },
    now: () => 0,
    logger: {
      info() {},
      warn() {},
      error: (message: string) => {
        errors.push(message);
      }
    },
    config: {
      baseDelayMs: 500,
      maxDelayMs: 4_000,
      maxAttempts: 4,
      healthyResetMs: 30_000
    }
  });

  const recovered = await controller.notifyExited();

  assert.equal(restartCount, 4);
  assert.deepEqual(delays, [500, 1_000, 2_000, 4_000]);
  assert.ok(errors.some((message) => message.includes("giving up")));
  assert.equal(recovered, false);
});

test("resets backoff after the daemon stays healthy", async () => {
  let restartCount = 0;
  let clock = 0;
  const delays: number[] = [];
  const controller = createDaemonRestartController({
    restart: async () => {
      restartCount += 1;
    },
    isStopRequested: () => false,
    delay: async (ms) => {
      delays.push(ms);
    },
    now: () => clock,
    logger: silentLogger(),
    config
  });

  await controller.notifyExited();
  clock = 60_000;
  await controller.notifyExited();

  assert.equal(restartCount, 2);
  assert.deepEqual(delays, [500, 500]);
});

test("keeps escalating backoff when the daemon dies again quickly", async () => {
  let clock = 0;
  const delays: number[] = [];
  const controller = createDaemonRestartController({
    restart: async () => {},
    isStopRequested: () => false,
    delay: async (ms) => {
      delays.push(ms);
    },
    now: () => clock,
    logger: silentLogger(),
    config
  });

  await controller.notifyExited();
  clock = 5_000;
  await controller.notifyExited();
  clock = 10_000;
  await controller.notifyExited();

  assert.deepEqual(delays, [500, 1_000, 2_000]);
});

test("ignores a second exit notification while restarting", async () => {
  let restartCount = 0;
  let delayCount = 0;
  let releaseDelay!: () => void;
  const delayGate = new Promise<void>((resolve) => {
    releaseDelay = resolve;
  });
  const controller = createDaemonRestartController({
    restart: async () => {
      restartCount += 1;
    },
    isStopRequested: () => false,
    delay: async () => {
      delayCount += 1;
      await delayGate;
    },
    now: () => 0,
    logger: silentLogger(),
    config
  });

  // First exit enters the restart loop and parks on the (held) delay.
  const first = controller.notifyExited();
  // Second exit while the first restart cycle is in flight must be a no-op.
  const second = controller.notifyExited();
  releaseDelay();
  await Promise.all([first, second]);

  assert.equal(restartCount, 1);
  assert.equal(delayCount, 1);
});

test("recovers auto-restart after give-up once the daemon is started again", async () => {
  let restartCount = 0;
  let restartSucceeds = false;
  let clock = 0;
  const controller = createDaemonRestartController({
    restart: async () => {
      restartCount += 1;
      if (!restartSucceeds) {
        throw new Error("daemon down");
      }
    },
    isStopRequested: () => false,
    delay: async () => {},
    now: () => clock,
    logger: silentLogger(),
    config: {
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: 3,
      healthyResetMs: 30_000
    }
  });

  // Every restart attempt fails, so the controller gives up.
  await controller.notifyExited();
  assert.equal(restartCount, 3);

  // The daemon recovers through a start() outside the restart loop.
  controller.notifyStarted();

  // It then stays healthy past the reset window and dies again.
  restartSucceeds = true;
  clock = 60_000;
  await controller.notifyExited();

  // Auto-restart is no longer permanently disabled.
  assert.equal(restartCount, 4);
});

test("still gives up when restarts keep failing after a healthy window", async () => {
  let restartCount = 0;
  let clock = 0;
  const controller = createDaemonRestartController({
    restart: async () => {
      restartCount += 1;
      throw new Error("daemon down");
    },
    // Safety bound: a buggy loop that resets the budget every iteration would
    // run forever, so stop it well past maxAttempts and assert on the count.
    isStopRequested: () => restartCount >= 10,
    delay: async () => {
      clock += 1_000;
    },
    now: () => clock,
    logger: silentLogger(),
    config: {
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: 3,
      healthyResetMs: 30_000
    }
  });

  // The daemon was healthy long ago; the healthy window has already elapsed.
  controller.notifyStarted();
  clock = 60_000;

  await controller.notifyExited();

  // The healthy-window reset must be consumed once, not on every retry.
  assert.equal(restartCount, 3);
});
