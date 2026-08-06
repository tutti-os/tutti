import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appCenterEn, appCenterZhCN } from "../i18n/appCenterI18n.ts";
import { resolveWorkspaceAppFailureMessageKey } from "./appFailurePresentation.ts";

describe("resolveWorkspaceAppFailureMessageKey", () => {
  it("maps install, start, runtime, and legacy failures to distinct copy", () => {
    assert.equal(
      resolveWorkspaceAppFailureMessageKey("downloading"),
      "messages.appInstallFailed"
    );
    assert.equal(
      resolveWorkspaceAppFailureMessageKey("installing"),
      "messages.appInstallFailed"
    );
    assert.equal(
      resolveWorkspaceAppFailureMessageKey("starting"),
      "messages.appStartFailed"
    );
    assert.equal(
      resolveWorkspaceAppFailureMessageKey("runtime"),
      "messages.appRuntimeFailed"
    );
    assert.equal(
      resolveWorkspaceAppFailureMessageKey(undefined),
      "messages.appUnknownFailure"
    );
    assert.equal(
      resolveWorkspaceAppFailureMessageKey(null),
      "messages.appUnknownFailure"
    );

    assert.deepEqual(
      {
        install: appCenterEn.messages.appInstallFailed,
        runtime: appCenterEn.messages.appRuntimeFailed,
        start: appCenterEn.messages.appStartFailed,
        unknown: appCenterEn.messages.appUnknownFailure
      },
      {
        install:
          "The app failed to install. Retry or open the logs for details.",
        runtime:
          "The app stopped unexpectedly. Open its session or logs for details.",
        start: "The app failed to start. Retry or open the logs for details.",
        unknown: "The app failed to run. Retry or open the logs for details."
      }
    );
    assert.deepEqual(
      {
        install: appCenterZhCN.messages.appInstallFailed,
        runtime: appCenterZhCN.messages.appRuntimeFailed,
        start: appCenterZhCN.messages.appStartFailed,
        unknown: appCenterZhCN.messages.appUnknownFailure
      },
      {
        install: "应用安装失败，请重试或查看日志",
        runtime: "应用运行异常，请打开会话或日志查看详情",
        start: "应用启动失败，请重试或查看日志",
        unknown: "应用运行失败，请重试或查看日志"
      }
    );
  });
});
