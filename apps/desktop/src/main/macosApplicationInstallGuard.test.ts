import assert from "node:assert/strict";
import test from "node:test";
import type { MessageBoxOptions } from "electron";
import {
  ensureMacosApplicationInstalled,
  shouldPromptToInstallMacosApplication
} from "./macosApplicationInstallGuard.ts";

test("macOS install guard skips development builds running from a mounted volume", () => {
  assert.equal(
    shouldPromptToInstallMacosApplication({
      appPath: "/Volumes/Tutti/Tutti.app/Contents/MacOS/Tutti",
      isPackaged: false,
      platform: "darwin"
    }),
    false
  );
});

test("macOS install guard skips packaged apps outside mounted volumes", () => {
  assert.equal(
    shouldPromptToInstallMacosApplication({
      appPath: "/Applications/Tutti.app/Contents/MacOS/Tutti",
      isPackaged: true,
      platform: "darwin"
    }),
    false
  );
});

test("macOS install guard prompts packaged apps running from mounted volumes", () => {
  assert.equal(
    shouldPromptToInstallMacosApplication({
      appPath: "/Volumes/Tutti/Tutti.app/Contents/MacOS/Tutti",
      isPackaged: true,
      platform: "darwin"
    }),
    true
  );
});

test("macOS install guard skips non-macOS platforms", () => {
  assert.equal(
    shouldPromptToInstallMacosApplication({
      appPath: "/Volumes/Tutti/Tutti.app/Contents/MacOS/Tutti",
      isPackaged: true,
      platform: "linux"
    }),
    false
  );
});

test("macOS install guard quits when the user declines installation", async () => {
  let quitCalls = 0;
  let moveCalls = 0;
  const shownDialogs: MessageBoxOptions[] = [];

  const canContinue = await ensureMacosApplicationInstalled({
    appPath: "/Volumes/Tutti/Tutti.app/Contents/MacOS/Tutti",
    isPackaged: true,
    locale: "en",
    moveToApplicationsFolder() {
      moveCalls += 1;
      return true;
    },
    platform: "darwin",
    quit() {
      quitCalls += 1;
    },
    showMessageBox(options) {
      shownDialogs.push(options);
      return Promise.resolve({ response: 1 });
    }
  });

  assert.equal(canContinue, false);
  assert.equal(moveCalls, 0);
  assert.equal(quitCalls, 1);
  assert.equal(shownDialogs.length, 1);
  assert.deepEqual(shownDialogs[0]?.buttons, [
    "Move to Applications and Relaunch",
    "Quit"
  ]);
});

test("macOS install guard stops startup after a successful move", async () => {
  let quitCalls = 0;
  let moveCalls = 0;

  const canContinue = await ensureMacosApplicationInstalled({
    appPath: "/Volumes/Tutti/Tutti.app/Contents/MacOS/Tutti",
    isPackaged: true,
    locale: "en",
    moveToApplicationsFolder() {
      moveCalls += 1;
      return true;
    },
    platform: "darwin",
    quit() {
      quitCalls += 1;
    },
    showMessageBox() {
      return Promise.resolve({ response: 0 });
    }
  });

  assert.equal(canContinue, false);
  assert.equal(moveCalls, 1);
  assert.equal(quitCalls, 0);
});

test("macOS install guard reveals the app bundle when automatic move fails", async () => {
  let quitCalls = 0;
  const revealedPaths: string[] = [];
  const shownDialogs: MessageBoxOptions[] = [];

  const canContinue = await ensureMacosApplicationInstalled({
    appPath: "/Volumes/Tutti/Tutti.app/Contents/MacOS/Tutti",
    isPackaged: true,
    locale: "zh-CN",
    moveToApplicationsFolder() {
      return false;
    },
    platform: "darwin",
    quit() {
      quitCalls += 1;
    },
    showItemInFolder(path) {
      revealedPaths.push(path);
    },
    showMessageBox(options) {
      shownDialogs.push(options);
      return Promise.resolve({ response: shownDialogs.length === 1 ? 0 : 0 });
    }
  });

  assert.equal(canContinue, false);
  assert.equal(quitCalls, 1);
  assert.deepEqual(revealedPaths, ["/Volumes/Tutti/Tutti.app"]);
  assert.equal(shownDialogs.length, 2);
  assert.deepEqual(shownDialogs[0]?.buttons, [
    "移动到 Applications 并重新打开",
    "退出"
  ]);
  assert.deepEqual(shownDialogs[1]?.buttons, ["在 Finder 中显示", "退出"]);
  assert.equal(shownDialogs[1]?.message, "请手动移动 Tutti");
});
