import assert from "node:assert/strict";
import test from "node:test";
import type { MessageBoxOptions } from "electron";
import type { ExportDeveloperLogsInput } from "../shared/contracts/ipc.ts";
import { createApplicationMenuTemplate } from "./applicationMenu.ts";

test("application menu exposes developer log export from Help", async () => {
  const exportedInputs: ExportDeveloperLogsInput[] = [];
  const menu = createApplicationMenuTemplate({
    exportDeveloperLogs(input) {
      exportedInputs.push(input);
    },
    platform: "darwin"
  });

  const helpMenu = menu.find((item) => item.label === "Help");
  assert.ok(helpMenu);
  assert.ok(Array.isArray(helpMenu.submenu));
  const exportItem = helpMenu.submenu.find(
    (item) => item.label === "Export Service Logs"
  );
  assert.ok(exportItem);
  assert.ok(Array.isArray(exportItem.submenu));
  const recentTenMinutesItem = exportItem.submenu.find(
    (item) => item.label === "Last 10 Minutes"
  );
  const recentThreeDaysItem = exportItem.submenu.find(
    (item) => item.label === "Last 3 Days"
  );
  assert.ok(recentTenMinutesItem);
  assert.ok(Array.isArray(recentTenMinutesItem.submenu));
  assert.ok(recentThreeDaysItem);
  assert.ok(Array.isArray(recentThreeDaysItem.submenu));

  const exportActions = [
    ...recentTenMinutesItem.submenu,
    ...recentThreeDaysItem.submenu
  ];
  assert.deepEqual(
    exportActions.map((item) => item.label),
    [
      "Logs Only",
      "Logs + Session Records",
      "Logs Only",
      "Logs + Session Records"
    ]
  );
  for (const action of exportActions) {
    action.click?.(
      {} as Parameters<NonNullable<typeof action.click>>[0],
      undefined as Parameters<NonNullable<typeof action.click>>[1],
      undefined as unknown as Parameters<NonNullable<typeof action.click>>[2]
    );
  }

  assert.deepEqual(exportedInputs, [
    { includeAgentSessions: false, scope: "recent-10-minutes" },
    { includeAgentSessions: true, scope: "recent-10-minutes" },
    { includeAgentSessions: false, scope: "recent-3-days" },
    { includeAgentSessions: true, scope: "recent-3-days" }
  ]);
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

test("application menu exposes check for updates from the app menu", async () => {
  let checked = false;
  const menu = createApplicationMenuTemplate({
    checkForUpdates() {
      checked = true;
    },
    platform: "darwin"
  });

  const appMenu = menu.find((item) => item.label === "Tutti");
  assert.ok(appMenu);
  assert.ok(Array.isArray(appMenu.submenu));
  const checkItem = appMenu.submenu.find(
    (item) => item.label === "Check for Updates..."
  );
  assert.ok(checkItem);

  checkItem.click?.(
    {} as Parameters<NonNullable<typeof checkItem.click>>[0],
    undefined as Parameters<NonNullable<typeof checkItem.click>>[1],
    undefined as unknown as Parameters<NonNullable<typeof checkItem.click>>[2]
  );

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(checked, true);
});

test("application menu shows an up-to-date dialog after a manual update check", async () => {
  const shownDialogs: MessageBoxOptions[] = [];
  const menu = createApplicationMenuTemplate({
    checkForUpdates() {
      return {
        currentVersion: "0.0.1-rc.17",
        status: "up_to_date"
      };
    },
    getLocale: () => "zh-CN",
    platform: "darwin",
    showMessageBox(options) {
      shownDialogs.push(options);
      return Promise.resolve({ response: 0 });
    }
  });

  const appMenu = menu.find((item) => item.label === "Tutti");
  assert.ok(appMenu);
  assert.ok(Array.isArray(appMenu.submenu));
  const checkItem = appMenu.submenu.find(
    (item) => item.label === "检查更新..."
  );
  assert.ok(checkItem);

  checkItem.click?.(
    {} as Parameters<NonNullable<typeof checkItem.click>>[0],
    undefined as Parameters<NonNullable<typeof checkItem.click>>[1],
    undefined as unknown as Parameters<NonNullable<typeof checkItem.click>>[2]
  );

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(shownDialogs, [
    {
      buttons: ["好"],
      detail: "Tutti 0.0.1-rc.17 是当前的最新版本。",
      message: "您使用的就是最新版本！",
      title: "Tutti",
      type: "info"
    }
  ]);
});

test("application menu localizes check for updates", () => {
  const menu = createApplicationMenuTemplate({
    getLocale: () => "zh-CN",
    platform: "darwin"
  });

  const appMenu = menu.find((item) => item.label === "Tutti");
  assert.ok(appMenu);
  assert.ok(Array.isArray(appMenu.submenu));
  assert.ok(appMenu.submenu.some((item) => item.label === "检查更新..."));
});

test("application menu routes Command-Q through the shortcut quit handler", () => {
  let shortcutQuitRequested = 0;
  const menu = createApplicationMenuTemplate({
    platform: "darwin",
    quitFromCommandShortcut() {
      shortcutQuitRequested += 1;
    }
  });

  const appMenu = menu.find((item) => item.label === "Tutti");
  assert.ok(appMenu);
  assert.ok(Array.isArray(appMenu.submenu));
  const quitItem = appMenu.submenu.find((item) => item.label === "Quit Tutti");
  assert.ok(quitItem);
  assert.equal(quitItem.accelerator, "Command+Q");

  quitItem.click?.(
    {} as Parameters<NonNullable<typeof quitItem.click>>[0],
    undefined as Parameters<NonNullable<typeof quitItem.click>>[1],
    undefined as unknown as Parameters<NonNullable<typeof quitItem.click>>[2]
  );

  assert.equal(shortcutQuitRequested, 1);
});

test("application menu routes Command-W through the shortcut close handler", () => {
  const ownerWindow = {};
  let receivedOwnerWindow: unknown;
  const menu = createApplicationMenuTemplate({
    closeFromCommandShortcut(nextOwnerWindow) {
      receivedOwnerWindow = nextOwnerWindow;
    },
    platform: "darwin"
  });

  const fileMenu = menu.find((item) => item.label === "File");
  assert.ok(fileMenu);
  assert.ok(Array.isArray(fileMenu.submenu));
  const closeItem = fileMenu.submenu.find((item) => item.label === "Close");
  assert.ok(closeItem);
  assert.equal(closeItem.accelerator, "Command+W");

  closeItem.click?.(
    {} as Parameters<NonNullable<typeof closeItem.click>>[0],
    ownerWindow as Parameters<NonNullable<typeof closeItem.click>>[1],
    undefined as unknown as Parameters<NonNullable<typeof closeItem.click>>[2]
  );

  assert.equal(receivedOwnerWindow, ownerWindow);
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
