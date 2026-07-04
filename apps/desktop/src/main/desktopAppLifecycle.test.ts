import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopAppLifecycleHandlers,
  requestDesktopAppQuitFromCommandShortcut,
  resetDesktopAppQuitShortcutForTest,
  type DesktopAppLifecycleRuntime
} from "./desktopAppLifecycle.ts";
import type { TuttidManager } from "./daemon/tuttidManager";
import type { WorkspaceLaunch } from "./host/workspaceLaunch";
import type { DesktopLogger } from "./logging";
import type { AppUpdateService } from "./update/appUpdateService";

function createLogger(events: string[]): DesktopLogger {
  return {
    debug() {},
    info(message) {
      events.push(`info:${message}`);
    },
    warn() {},
    error(message) {
      events.push(`error:${message}`);
    },
    async close() {
      events.push("logger:close");
    }
  };
}

function createWorkspaceLaunch(): WorkspaceLaunch {
  return {
    async openStartupWindow() {},
    async showWorkspace() {}
  };
}

function createUpdateService(
  events: string[],
  options: { quitAndInstallPending?: boolean } = {}
): AppUpdateService {
  return {
    async checkForUpdates() {
      throw new Error("not used");
    },
    async configure() {
      throw new Error("not used");
    },
    dispose() {
      events.push("update:dispose");
    },
    async downloadUpdate() {
      throw new Error("not used");
    },
    getState() {
      throw new Error("not used");
    },
    async installUpdate() {
      throw new Error("not used");
    },
    isQuitAndInstallPending() {
      return options.quitAndInstallPending ?? false;
    },
    onStateChanged() {
      return () => undefined;
    }
  };
}

function createRuntime(events: string[]): DesktopAppLifecycleRuntime {
  return {
    destroyAllWindows() {
      events.push("windows:destroy-all");
    },
    getWindowCount() {
      return 0;
    },
    quit() {
      events.push("app:quit");
    },
    showQuitShortcutToast() {
      events.push("windows:show-quit-shortcut-toast");
    }
  };
}

function createTuttidManager(stop: () => Promise<void>): TuttidManager {
  return {
    async getHealth() {
      throw new Error("not used");
    },
    start() {
      return Promise.resolve();
    },
    stop
  };
}

test("before quit waits for managed tuttid stop before quitting the app", async () => {
  const events: string[] = [];
  const stopSignal: { resolve: null | (() => void) } = { resolve: null };
  const stopPromise = new Promise<void>((resolve) => {
    stopSignal.resolve = resolve;
  });
  const handlers = createDesktopAppLifecycleHandlers(
    {
      logger: createLogger(events),
      tuttid: createTuttidManager(async () => {
        events.push("tuttid:stop:start");
        await stopPromise;
        events.push("tuttid:stop:done");
      }),
      updateService: createUpdateService(events),
      workspaceLaunch: createWorkspaceLaunch()
    },
    createRuntime(events)
  );

  let prevented = false;
  handlers.beforeQuit({
    preventDefault() {
      prevented = true;
      events.push("quit:prevented");
    }
  });

  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, true);
  assert.equal(
    events.join("|"),
    [
      "quit:prevented",
      "info:desktop app before quit",
      "tuttid:stop:start"
    ].join("|")
  );

  const releaseStop = stopSignal.resolve;
  if (!releaseStop) {
    throw new Error("expected stop resolver to be initialized");
  }
  releaseStop();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    events.slice(0, 3).join("|"),
    [
      "quit:prevented",
      "info:desktop app before quit",
      "tuttid:stop:start"
    ].join("|")
  );
  assert.equal(events.includes("tuttid:stop:done"), true);
  assert.equal(events.includes("windows:destroy-all"), true);
  assert.equal(events.at(-1), "app:quit");
});

test("before quit waits for managed tuttid stop when update install is pending", async () => {
  const events: string[] = [];
  const handlers = createDesktopAppLifecycleHandlers(
    {
      logger: createLogger(events),
      tuttid: createTuttidManager(async () => {
        events.push("tuttid:stop");
      }),
      updateService: createUpdateService(events, {
        quitAndInstallPending: true
      }),
      workspaceLaunch: createWorkspaceLaunch()
    },
    createRuntime(events)
  );

  let prevented = false;
  handlers.beforeQuit({
    preventDefault() {
      prevented = true;
      events.push("quit:prevented");
    }
  });

  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, true);
  assert.equal(
    events.join("|"),
    [
      "quit:prevented",
      "info:desktop app before quit for update install",
      "tuttid:stop",
      "windows:destroy-all",
      "app:quit"
    ].join("|")
  );
});

test("before quit does not trigger a second stop while shutdown is already in progress", async () => {
  const events: string[] = [];
  const handlers = createDesktopAppLifecycleHandlers(
    {
      logger: createLogger(events),
      tuttid: createTuttidManager(async () => {
        events.push("tuttid:stop");
      }),
      updateService: createUpdateService(events),
      workspaceLaunch: createWorkspaceLaunch()
    },
    createRuntime(events)
  );

  handlers.beforeQuit({
    preventDefault() {
      events.push("quit:prevented");
    }
  });
  handlers.beforeQuit({
    preventDefault() {
      events.push("quit:prevented:again");
    }
  });

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    events.join("|"),
    [
      "quit:prevented",
      "info:desktop app before quit",
      "tuttid:stop",
      "windows:destroy-all",
      "app:quit"
    ].join("|")
  );
});

test("command quit shortcut shows a toast before quitting on the next press", () => {
  const events: string[] = [];
  resetDesktopAppQuitShortcutForTest();

  requestDesktopAppQuitFromCommandShortcut({
    now: () => 1_000,
    quit: () => events.push("app:quit"),
    showQuitShortcutToast: () => events.push("toast")
  });
  requestDesktopAppQuitFromCommandShortcut({
    now: () => 2_000,
    quit: () => events.push("app:quit"),
    showQuitShortcutToast: () => events.push("toast")
  });

  assert.deepEqual(events, ["toast", "app:quit"]);
  resetDesktopAppQuitShortcutForTest();
});

test("command quit shortcut confirmation expires", () => {
  const events: string[] = [];
  resetDesktopAppQuitShortcutForTest();

  requestDesktopAppQuitFromCommandShortcut({
    now: () => 1_000,
    quit: () => events.push("app:quit"),
    showQuitShortcutToast: () => events.push("toast")
  });
  requestDesktopAppQuitFromCommandShortcut({
    now: () => 7_000,
    quit: () => events.push("app:quit"),
    showQuitShortcutToast: () => events.push("toast")
  });

  assert.deepEqual(events, ["toast", "toast"]);
  resetDesktopAppQuitShortcutForTest();
});
