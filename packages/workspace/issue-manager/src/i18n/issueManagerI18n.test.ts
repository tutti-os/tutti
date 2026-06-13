import assert from "node:assert/strict";
import test from "node:test";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createIssueManagerI18nRuntime,
  issueManagerI18nResources
} from "./issueManagerI18n.ts";

test("zh-CN task acceptance label is issue-scoped", () => {
  const copy = createIssueManagerI18nRuntime(
    createI18nRuntime({ dictionaries: [issueManagerI18nResources["zh-CN"]] })
  );

  assert.equal(copy.t("labels.taskAcceptance"), "任务待验收");
});
