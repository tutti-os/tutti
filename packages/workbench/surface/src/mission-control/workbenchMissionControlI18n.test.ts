import assert from "node:assert/strict";
import test from "node:test";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createWorkbenchMissionControlI18nRuntime,
  workbenchMissionControlI18nResources
} from "./workbenchMissionControlI18n.ts";

test("mission control layout availability copy is localized", () => {
  const enI18n = createWorkbenchMissionControlI18nRuntime(
    createI18nRuntime({
      dictionaries: [workbenchMissionControlI18nResources.en]
    })
  );
  const zhI18n = createWorkbenchMissionControlI18nRuntime(
    createI18nRuntime({
      dictionaries: [workbenchMissionControlI18nResources["zh-CN"]]
    })
  );

  assert.equal(
    enI18n.t("noAvailableLayout"),
    "No layout fits the selected windows"
  );
  assert.equal(zhI18n.t("noAvailableLayout"), "当前没有可用布局");
});
