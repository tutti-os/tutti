import assert from "node:assert/strict";
import test from "node:test";
import {
  toggleHostWindowMaximize,
  type HostWindowMaximizePort
} from "./hostWindowMaximize.ts";

test("host window maximize toggles workspace maximize state", () => {
  const state = createWindowState();
  toggleHostWindowMaximize(state.window, "workspace");
  assert.equal(state.maximized, true);
  assert.equal(state.fullScreen, false);

  toggleHostWindowMaximize(state.window, "workspace");
  assert.equal(state.maximized, false);
  assert.equal(state.fullScreen, false);
});

test("host window maximize keeps Agent windows on native fullscreen", () => {
  const state = createWindowState();
  toggleHostWindowMaximize(state.window, "agent");
  assert.equal(state.fullScreen, true);
  assert.equal(state.maximized, false);

  toggleHostWindowMaximize(state.window, "agent");
  assert.equal(state.fullScreen, false);
});

function createWindowState(): {
  fullScreen: boolean;
  maximized: boolean;
  window: HostWindowMaximizePort;
} {
  const state = {
    fullScreen: false,
    maximized: false,
    window: null as unknown as HostWindowMaximizePort
  };
  state.window = {
    isFullScreen: () => state.fullScreen,
    isMaximized: () => state.maximized,
    maximize: () => {
      state.maximized = true;
    },
    setFullScreen: (fullScreen) => {
      state.fullScreen = fullScreen;
    },
    unmaximize: () => {
      state.maximized = false;
    }
  };
  return state;
}
