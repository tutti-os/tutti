import assert from "node:assert/strict";
import test from "node:test";
import { workspaceProtocolErrorCodes } from "@tutti-os/client-tuttid-ts";
import { desktopErrorCodes } from "../../../shared/errors/desktopErrors.ts";
import {
  resolveDesktopErrorMessage,
  wrapLocalizedTuttidErrorIfSpecific
} from "./desktopErrors.ts";

test("resolveDesktopErrorMessage uses shared protocol-code defaults", () => {
  const message = resolveDesktopErrorMessage({
    code: workspaceProtocolErrorCodes.workspaceNotFound,
    reason: "workspace_not_found",
    developerMessage: "workspace not found"
  });

  assert.equal(message, "That workspace could not be found.");
});

test("resolveDesktopErrorMessage localizes shared protocol-code defaults", () => {
  const message = resolveDesktopErrorMessage(
    {
      code: workspaceProtocolErrorCodes.workspaceNotFound,
      reason: "workspace_not_found",
      developerMessage: "workspace not found"
    },
    "zh-CN"
  );

  assert.equal(message, "找不到这个工作区。");
});

test("resolveDesktopErrorMessage supports per-view overrides", () => {
  const message = resolveDesktopErrorMessage(
    {
      code: workspaceProtocolErrorCodes.workspaceNotFound,
      reason: "workspace_not_found",
      developerMessage: "workspace not found"
    },
    "en",
    {
      [workspaceProtocolErrorCodes.workspaceNotFound]:
        "This workspace record no longer exists. Reopen it from the workspaces page."
    }
  );

  assert.equal(
    message,
    "This workspace record no longer exists. Reopen it from the workspaces page."
  );
});

test("resolveDesktopErrorMessage prefers reason-specific translations", () => {
  const message = resolveDesktopErrorMessage(
    {
      code: "invalid_request",
      reason: "missing_workspace_name",
      developerMessage: "workspace name is required"
    },
    "en"
  );

  assert.equal(message, "Enter a workspace name to continue.");
});

test("resolveDesktopErrorMessage falls back to grouped default translations", () => {
  const message = resolveDesktopErrorMessage(
    {
      code: "invalid_request",
      reason: "future_invalid_reason",
      developerMessage: "future invalid request"
    },
    "en"
  );

  assert.equal(message, "That request could not be completed.");
});

test("wrapLocalizedTuttidErrorIfSpecific preserves protocol metadata for reason-specific errors", () => {
  const source = {
    code: "workspace_operation_failed",
    correlationId: "corr-1",
    developerMessage: "opencode: ACP adapter not found",
    reason: "acp_adapter_version_mismatch",
    retryable: false,
    statusCode: 502
  };
  const wrapped = wrapLocalizedTuttidErrorIfSpecific(source, "en");

  assert.ok(wrapped instanceof Error);
  assert.match(wrapped.message, /The local agent adapter is unavailable/);
  assert.equal(
    (wrapped as { code?: string }).code,
    "workspace_operation_failed"
  );
  assert.equal(
    (wrapped as { reason?: string }).reason,
    "acp_adapter_version_mismatch"
  );
  assert.equal((wrapped as { correlationId?: string }).correlationId, "corr-1");
});

test("wrapLocalizedTuttidErrorIfSpecific returns the original error without reason-specific copy", () => {
  const source = {
    code: "workspace_operation_failed",
    developerMessage: "generic failure",
    reason: "workspace_operation_failed",
    statusCode: 502
  };

  assert.equal(wrapLocalizedTuttidErrorIfSpecific(source, "en"), source);
});

test("resolveDesktopErrorMessage localizes workspace operation reason details", () => {
  const message = resolveDesktopErrorMessage(
    {
      code: "workspace_operation_failed",
      reason: "acp_adapter_version_mismatch",
      developerMessage: "opencode: ACP adapter not found"
    },
    "zh-CN"
  );

  assert.equal(
    message,
    "本地 Agent 适配器不可用或版本不匹配。请先在 Dock 中重新连接 Agent，然后重试。"
  );
});

test("resolveDesktopErrorMessage localizes file-manager invalid path reasons", () => {
  const message = resolveDesktopErrorMessage(
    {
      code: "invalid_request",
      reason: "path_escapes_root",
      developerMessage: "workspace file path escapes root"
    },
    "zh-CN"
  );

  assert.equal(message, "这个路径超出了工作区根目录范围。");
});

test("resolveDesktopErrorMessage localizes workspace app icon validation errors", () => {
  const message = resolveDesktopErrorMessage(
    {
      code: "invalid_request",
      reason: "workspace_app_icon_invalid",
      developerMessage: "workspace app icon is invalid"
    },
    "zh-CN"
  );

  assert.equal(message, "请选择 5 MB 以内的 PNG、JPG 或 WebP 图片。");
});

test("resolveDesktopErrorMessage localizes service-unavailable reasons", () => {
  const message = resolveDesktopErrorMessage(
    {
      code: "service_unavailable",
      reason: "workspace_file_service_unavailable",
      developerMessage: "workspace file service is unavailable"
    },
    "en"
  );

  assert.equal(message, "Workspace files are temporarily unavailable.");
});

test("resolveDesktopErrorMessage localizes desktop-local error codes", () => {
  assert.equal(
    resolveDesktopErrorMessage({
      code: desktopErrorCodes.transportTimeout,
      message: "timed out"
    }),
    "That desktop request timed out."
  );
});

test("resolveDesktopErrorMessage localizes broken Node runtime errors", () => {
  assert.equal(
    resolveDesktopErrorMessage(
      {
        code: desktopErrorCodes.nodeRuntimeBroken,
        message:
          "dyld[66795]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.30.dylib"
      },
      "zh-CN"
    ),
    "npm 使用的 Node.js 运行时已损坏。请检查终端中的 Node/npm 配置后重试。"
  );
});

test("resolveDesktopErrorMessage maps non-protocol errors to desktop fallbacks", () => {
  assert.equal(
    resolveDesktopErrorMessage(new Error("plain failure")),
    "An unexpected service error occurred. Please try again."
  );
});

test("resolveDesktopErrorMessage falls back to generic service copy for unknown codes", () => {
  assert.equal(
    resolveDesktopErrorMessage({
      code: "future_desktop_error_code",
      message: "future failure"
    }),
    "An unexpected service error occurred. Please try again."
  );
});

test("resolveDesktopErrorMessage localizes unknown errors", () => {
  assert.equal(resolveDesktopErrorMessage(null, "zh-CN"), "未知错误");
});
