import assert from "node:assert/strict";
import test from "node:test";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createDesktopErrorI18nRuntime,
  desktopErrorI18nResources
} from "../desktopErrorI18n.ts";
import {
  createWorkspaceWorkbenchDesktopI18nRuntime,
  workspaceWorkbenchDesktopI18nKeys,
  workspaceWorkbenchDesktopI18nResources
} from "../workspaceWorkbenchDesktopI18n.ts";
import { en } from "../locales/en.ts";
import { zhCN } from "../locales/zh-CN.ts";
import {
  workbenchHostI18nResources,
  workbenchMissionControlI18nResources,
  workbenchWindowChromeI18nResources
} from "../../../../../../packages/workbench/surface/src/i18n/index.ts";
import { workspaceFileManagerI18nResources } from "../../../../../../packages/workspace/file-manager/src/i18n/workspaceFileManagerI18n.ts";
import {
  normalizeDesktopLocale,
  resolveDesktopLocaleFromCandidates
} from "./locale.ts";
import { createTranslator } from "./translate.ts";

test("normalizeDesktopLocale maps supported language tags to desktop locales", () => {
  assert.equal(normalizeDesktopLocale("zh-Hans-CN"), "zh-CN");
  assert.equal(normalizeDesktopLocale("en-US"), "en");
  assert.equal(normalizeDesktopLocale("fr-FR"), null);
});

test("resolveDesktopLocaleFromCandidates returns the first supported locale", () => {
  assert.equal(
    resolveDesktopLocaleFromCandidates([null, "fr-FR", "zh-Hant-TW"]),
    "zh-CN"
  );
  assert.equal(resolveDesktopLocaleFromCandidates(["fr-FR"], "en"), "en");
});

test("createTranslator returns localized messages and interpolates params", () => {
  assert.equal(
    createTranslator("zh-CN").t("dashboard.readyStatus", { count: 3 }),
    "已就绪 3 个"
  );
});

test("createTranslator localizes error messages", () => {
  assert.equal(
    createTranslator("zh-CN").t("errors.workspace_not_found"),
    "找不到这个工作区。"
  );
});

test("createTranslator returns the key when a message cannot be resolved", () => {
  assert.equal(createTranslator("en").t("missing.key" as never), "missing.key");
});

test("desktop workbench i18n resources project shared locale values", () => {
  const enI18n = createWorkspaceWorkbenchDesktopI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceWorkbenchDesktopI18nResources.en]
    })
  );
  const zhI18n = createWorkspaceWorkbenchDesktopI18nRuntime(
    createI18nRuntime({
      dictionaries: [workspaceWorkbenchDesktopI18nResources["zh-CN"]]
    })
  );

  assert.equal(
    enI18n.t(workspaceWorkbenchDesktopI18nKeys.nodes.files),
    en.workspace.workbenchDesktop.nodes.files
  );
  assert.equal(
    zhI18n.t(workspaceWorkbenchDesktopI18nKeys.nodes.files),
    zhCN.workspace.workbenchDesktop.nodes.files
  );
});

test("desktop error i18n resources project shared locale values", () => {
  const enI18n = createDesktopErrorI18nRuntime("en");
  const zhI18n = createDesktopErrorI18nRuntime("zh-CN");

  assert.equal(
    enI18n.t("errors.workspace_not_found"),
    en.errors.workspace_not_found
  );
  assert.equal(zhI18n.t("common.unknownError"), zhCN.common.unknownError);
});

test("app i18n runtime keeps package defaults and lets host overrides win", () => {
  const runtime = createI18nRuntime({
    dictionaries: [
      {
        workspace: {
          workbenchDesktop: {
            nodes: {
              files: "Project files"
            }
          }
        },
        workspaceFileManager: {
          uploadLabel: "Send"
        },
        workbenchWindowChrome: {
          enterFullscreen: "Expand window"
        },
        errors: {
          workspace_not_found: "Missing local workspace"
        }
      },
      desktopErrorI18nResources.en,
      workspaceWorkbenchDesktopI18nResources.en,
      workspaceFileManagerI18nResources.en,
      workbenchHostI18nResources.en,
      workbenchMissionControlI18nResources.en,
      workbenchWindowChromeI18nResources.en
    ]
  });

  const desktopWorkbenchI18n =
    createWorkspaceWorkbenchDesktopI18nRuntime(runtime);

  assert.equal(
    desktopWorkbenchI18n.t(workspaceWorkbenchDesktopI18nKeys.nodes.files),
    "Project files"
  );
  assert.equal(runtime.t("workspaceFileManager.uploadLabel"), "Send");
  assert.equal(
    runtime.t("workbenchHost.actions.close"),
    "Close workbench window"
  );
  assert.equal(
    runtime.t("workbenchWindowChrome.enterFullscreen"),
    "Expand window"
  );
  assert.equal(
    runtime.t("errors.workspace_not_found"),
    "Missing local workspace"
  );
  assert.equal(runtime.t("common.unknownError"), en.common.unknownError);
});
