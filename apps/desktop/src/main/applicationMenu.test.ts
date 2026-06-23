import assert from "node:assert/strict";
import test from "node:test";
import type { MessageBoxOptions } from "electron";
import { createApplicationMenuTemplate } from "./applicationMenu.ts";

test("application menu exposes developer log export from Help", async () => {
  let exported = false;
  const menu = createApplicationMenuTemplate({
    exportDeveloperLogs() {
      exported = true;
    },
    platform: "darwin"
  });

  const helpMenu = menu.find((item) => item.label === "Help");
  assert.ok(helpMenu);
  assert.ok(Array.isArray(helpMenu.submenu));
  const exportItem = helpMenu.submenu.find(
    (item) => item.label === "Export Service Logs..."
  );
  assert.ok(exportItem);

  exportItem.click?.(
    {} as Parameters<NonNullable<typeof exportItem.click>>[0],
    undefined as Parameters<NonNullable<typeof exportItem.click>>[1],
    undefined as unknown as Parameters<NonNullable<typeof exportItem.click>>[2]
  );

  assert.equal(exported, true);
});

test("application menu exposes developer log clearing from Help", async () => {
  let cleared = false;
  const shownDialogs: MessageBoxOptions[] = [];
  const menu = createApplicationMenuTemplate({
    clearDeveloperLogs() {
      cleared = true;
      return {
        clearedFiles: 2,
        clearedPaths: [],
        clearedSizeBytes: 0
      };
    },
    getLocale: () => "zh-CN",
    platform: "darwin",
    showMessageBox(options) {
      shownDialogs.push(options);
      return Promise.resolve({ response: 0 });
    }
  });

  const helpMenu = menu.find((item) => item.label === "帮助");
  assert.ok(helpMenu);
  assert.ok(Array.isArray(helpMenu.submenu));
  const clearItem = helpMenu.submenu.find(
    (item) => item.label === "清除服务日志..."
  );
  assert.ok(clearItem);

  clearItem.click?.(
    {} as Parameters<NonNullable<typeof clearItem.click>>[0],
    undefined as Parameters<NonNullable<typeof clearItem.click>>[1],
    undefined as unknown as Parameters<NonNullable<typeof clearItem.click>>[2]
  );

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cleared, true);
  assert.deepEqual(shownDialogs, [
    {
      buttons: ["好"],
      detail: "已清除 2 个日志文件。",
      message: "服务日志已清除。",
      title: "清除日志",
      type: "info"
    }
  ]);
});

test("application menu hides check for updates from the app menu", () => {
  const menu = createApplicationMenuTemplate({
    platform: "darwin"
  });

  const appMenu = menu.find((item) => item.label === "Tutti");
  assert.ok(appMenu);
  assert.ok(Array.isArray(appMenu.submenu));
  const checkItem = appMenu.submenu.find(
    (item) => item.label === "Check for Updates..."
  );
  assert.equal(checkItem, undefined);
});

test("application menu hides check for updates from Help on non-macOS", () => {
  const menu = createApplicationMenuTemplate({
    getLocale: () => "zh-CN",
    platform: "win32"
  });

  const helpMenu = menu.find((item) => item.label === "帮助");
  assert.ok(helpMenu);
  assert.ok(Array.isArray(helpMenu.submenu));
  assert.equal(
    helpMenu.submenu.some((item) => item.label === "检查更新..."),
    false
  );
});

test("application menu exposes Perf Monitor DevTools when configured", () => {
  const ownerWindow = {};
  let receivedOwnerWindow: unknown;
  const menu = createApplicationMenuTemplate({
    allowDeveloperTools: true,
    openPerfMonitorDevTools(browserWindow) {
      receivedOwnerWindow = browserWindow;
    },
    platform: "darwin"
  });

  const viewMenu = menu.find((item) => item.label === "View");
  assert.ok(viewMenu);
  assert.ok(Array.isArray(viewMenu.submenu));
  const perfMonitorItem = viewMenu.submenu.find(
    (item) => item.label === "Open Perf Monitor DevTools"
  );
  assert.ok(perfMonitorItem);

  perfMonitorItem.click?.(
    {} as Parameters<NonNullable<typeof perfMonitorItem.click>>[0],
    ownerWindow as Parameters<NonNullable<typeof perfMonitorItem.click>>[1],
    undefined as unknown as Parameters<
      NonNullable<typeof perfMonitorItem.click>
    >[2]
  );

  assert.equal(receivedOwnerWindow, ownerWindow);
});

test("application menu hides Perf Monitor DevTools without a handler", () => {
  const menu = createApplicationMenuTemplate({
    allowDeveloperTools: true,
    platform: "darwin"
  });

  const viewMenu = menu.find((item) => item.label === "View");
  assert.ok(viewMenu);
  assert.ok(Array.isArray(viewMenu.submenu));
  assert.equal(
    viewMenu.submenu.some(
      (item) => item.label === "Open Perf Monitor DevTools"
    ),
    false
  );
});
