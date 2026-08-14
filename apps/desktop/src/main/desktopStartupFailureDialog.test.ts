import assert from "node:assert/strict";
import test from "node:test";
import { showDesktopStartupFailureDialog } from "./desktopStartupFailureDialog.ts";
import {
  desktopStartupFailure,
  isDaemonStartupFailure,
} from "./desktopStartupFailureProtocol.ts";
import { desktopErrorCodes } from "../shared/errors/desktopErrors.ts";

test("startup failure dialog explains preserved data and opens logs", async () => {
  const opened: string[] = [];
  let detail = "";
  await showDesktopStartupFailureDialog({
    failureKind: "daemon",
    locale: "zh-CN",
    logsDirectory: "C:\\Users\\demo\\.tutti\\logs",
    platform: "win32",
    async openPath(path) {
      opened.push(path);
      return "";
    },
    async showMessageBox(options) {
      detail = options.detail;
      return { response: 0 };
    },
  });

  assert.match(detail, /数据未被删除/);
  assert.match(detail, /卸载时选择删除全部用户数据/);
  assert.deepEqual(opened, ["C:\\Users\\demo\\.tutti\\logs"]);
});

test("startup failure dialog does not suggest a Windows-only reset elsewhere", async () => {
  let detail = "";
  await showDesktopStartupFailureDialog({
    failureKind: "daemon",
    locale: "en-US",
    logsDirectory: "/tmp/tutti/logs",
    platform: "darwin",
    async openPath() {
      return "";
    },
    async showMessageBox(options) {
      detail = options.detail;
      return { response: 1 };
    },
  });

  assert.doesNotMatch(detail, /uninstall/i);
  assert.match(detail, /Open the logs folder/);
});

test("generic bootstrap failures never recommend deleting user data", async () => {
  let detail = "";
  await showDesktopStartupFailureDialog({
    failureKind: "general",
    locale: "zh-CN",
    logsDirectory: "C:\\tmp\\logs",
    platform: "win32",
    async openPath() {
      return "";
    },
    async showMessageBox(options) {
      detail = options.detail;
      return { response: 1 };
    },
  });

  assert.doesNotMatch(detail, /删除全部用户数据/);
  assert.match(detail, /不一定能解决/);
});

test("only classified daemon startup failures enable clean-reset guidance", () => {
  const daemonError = new Error("listener unavailable", {
    cause: {
      code: desktopErrorCodes.managedProcessStderr,
      message: "file is not a database",
    },
  });
  assert.equal(
    isDaemonStartupFailure(desktopStartupFailure(daemonError)),
    true,
  );
  assert.equal(
    isDaemonStartupFailure(desktopStartupFailure(new Error("window failed"))),
    false,
  );
  const noStderrExit = Object.assign(
    new Error("tuttid exited before it published listener info"),
    { code: desktopErrorCodes.managedProcessError },
  );
  assert.equal(
    isDaemonStartupFailure(desktopStartupFailure(noStderrExit)),
    true,
  );
});
