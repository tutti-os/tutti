import assert from "node:assert/strict";
import test from "node:test";
import { en } from "../../shared/i18n/locales/en.ts";
import { zhCN } from "../../shared/i18n/locales/zh-CN.ts";
import { resolveWorkspaceWindowUnknownErrorMessage } from "./workspaceWindowUnknownErrorMessage.ts";

test("uses the canonical lang query before the renderer applies its locale", () => {
  assert.equal(
    resolveWorkspaceWindowUnknownErrorMessage({
      documentLanguage: "",
      search: "?view=workspace&lang=zh-CN"
    }),
    zhCN.common.unknownError
  );
});

test("uses the current document language after a runtime locale change", () => {
  const search = "?view=workspace&lang=en";

  assert.equal(
    resolveWorkspaceWindowUnknownErrorMessage({
      documentLanguage: "en",
      search
    }),
    en.common.unknownError
  );
  assert.equal(
    resolveWorkspaceWindowUnknownErrorMessage({
      documentLanguage: "zh-CN",
      search
    }),
    zhCN.common.unknownError
  );
});
