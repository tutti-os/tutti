import assert from "node:assert/strict";
import test from "node:test";
import { createI18nRuntime, type I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createWorkspaceUserProjectI18nRuntime,
  workspaceUserProjectI18nResources,
  type WorkspaceUserProjectI18nRuntime
} from "./workspaceUserProjectI18n.ts";

test("workspace user project i18n resolves package defaults", () => {
  const i18n: WorkspaceUserProjectI18nRuntime =
    createWorkspaceUserProjectI18nRuntime();

  assert.equal(i18n.t("projectSelect.projectLabel"), "Project");
  assert.equal(i18n.t("projectSelect.noProject"), "No project");
  assert.equal(
    i18n.t("projectSelect.createProjectNameLabel"),
    "Enter a project name. A folder will be created in Documents/tutti"
  );
  assert.equal(
    i18n.t("projectSelect.createProjectFailed"),
    "Unable to create project"
  );
});

test("workspace user project i18n follows merged host locale resources", () => {
  const runtime: I18nRuntime<string> = createI18nRuntime({
    dictionaries: [workspaceUserProjectI18nResources["zh-CN"]]
  });
  const i18n: WorkspaceUserProjectI18nRuntime =
    createWorkspaceUserProjectI18nRuntime(runtime);

  assert.equal(i18n.t("projectSelect.projectLabel"), "项目");
  assert.equal(i18n.t("projectSelect.noProject"), "不使用项目");
  assert.equal(i18n.t("projectSelect.linkExistingProject"), "使用已有项目");
  assert.equal(
    i18n.t("projectSelect.createProjectNameLabel"),
    "输入项目名称。系统会在 Documents/tutti 中创建文件夹"
  );
});
