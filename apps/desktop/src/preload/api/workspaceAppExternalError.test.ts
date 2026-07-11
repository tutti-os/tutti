import assert from "node:assert/strict";
import test from "node:test";
import { en } from "../../shared/i18n/locales/en.ts";
import { zhCN } from "../../shared/i18n/locales/zh-CN.ts";
import { normalizeWorkspaceAppExternalErrorDetails } from "./workspaceAppExternalError.ts";

test("resolves the unknown error fallback for every failed request", () => {
  let unknownErrorMessage: string = en.common.unknownError;
  const getUnknownErrorMessage = () => unknownErrorMessage;

  assert.equal(
    normalizeWorkspaceAppExternalErrorDetails({}, getUnknownErrorMessage)
      .message,
    en.common.unknownError
  );

  unknownErrorMessage = zhCN.common.unknownError;
  assert.equal(
    normalizeWorkspaceAppExternalErrorDetails({}, getUnknownErrorMessage)
      .message,
    zhCN.common.unknownError
  );
});
