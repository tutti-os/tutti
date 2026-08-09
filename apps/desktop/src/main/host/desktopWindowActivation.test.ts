import assert from "node:assert/strict";
import test from "node:test";
import {
  activateDesktopWindow,
  type DesktopWindowActivationApplication,
  type DesktopWindowActivationTarget
} from "./desktopWindowActivation.ts";

test("restores regular macOS application presence before focusing the window", () => {
  const calls: string[] = [];

  assert.equal(
    activateDesktopWindow(
      createApplication(calls),
      createWindow(calls, { minimized: true }),
      "darwin"
    ),
    true
  );
  assert.deepEqual(calls, [
    "app.policy:regular",
    "app.show",
    "app.focus:steal",
    "window.restore",
    "window.show",
    "window.focus"
  ]);
});

test("uses ordinary application focus outside macOS", () => {
  const calls: string[] = [];

  assert.equal(
    activateDesktopWindow(
      createApplication(calls),
      createWindow(calls),
      "win32"
    ),
    true
  );
  assert.deepEqual(calls, ["app.focus", "window.show", "window.focus"]);
});

test("does not activate a destroyed window", () => {
  const calls: string[] = [];

  assert.equal(
    activateDesktopWindow(
      createApplication(calls),
      createWindow(calls, { destroyed: true }),
      "darwin"
    ),
    false
  );
  assert.deepEqual(calls, []);
});

function createApplication(
  calls: string[]
): DesktopWindowActivationApplication {
  return {
    focus(options) {
      calls.push(options?.steal ? "app.focus:steal" : "app.focus");
    },
    setActivationPolicy(policy) {
      calls.push(`app.policy:${policy}`);
    },
    show() {
      calls.push("app.show");
    }
  };
}

function createWindow(
  calls: string[],
  options: { destroyed?: boolean; minimized?: boolean } = {}
): DesktopWindowActivationTarget {
  return {
    focus() {
      calls.push("window.focus");
    },
    isDestroyed() {
      return options.destroyed === true;
    },
    isMinimized() {
      return options.minimized === true;
    },
    restore() {
      calls.push("window.restore");
    },
    show() {
      calls.push("window.show");
    }
  };
}
