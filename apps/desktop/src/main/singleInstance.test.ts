import assert from "node:assert/strict";
import test from "node:test";
import { ensureSingleInstance } from "./singleInstance.ts";

test("quits and reports non-primary when the lock is not acquired", () => {
  let quitCalls = 0;
  let secondInstanceRegistered = false;

  const isPrimary = ensureSingleInstance({
    requestSingleInstanceLock: () => false,
    quit: () => {
      quitCalls += 1;
    },
    onSecondInstance: () => {
      secondInstanceRegistered = true;
    },
    focusPrimaryWindow: () => {}
  });

  assert.equal(isPrimary, false);
  assert.equal(quitCalls, 1);
  assert.equal(secondInstanceRegistered, false);
});

test("reports primary and focuses the window on a second-instance event", () => {
  let quitCalls = 0;
  let focusCalls = 0;
  let handledArgv: readonly string[] | undefined;
  let registeredHandler: ((argv: readonly string[]) => void) | undefined;

  const isPrimary = ensureSingleInstance({
    requestSingleInstanceLock: () => true,
    quit: () => {
      quitCalls += 1;
    },
    onSecondInstance: (handler) => {
      registeredHandler = handler;
    },
    handleSecondInstanceArgv: (argv) => {
      handledArgv = argv;
    },
    focusPrimaryWindow: () => {
      focusCalls += 1;
    }
  });

  assert.equal(isPrimary, true);
  assert.equal(quitCalls, 0);
  assert.ok(registeredHandler, "second-instance handler should be registered");

  registeredHandler?.(["tutti-dev://login/callback"]);
  assert.equal(focusCalls, 1);
  assert.deepEqual(handledArgv, ["tutti-dev://login/callback"]);
});
