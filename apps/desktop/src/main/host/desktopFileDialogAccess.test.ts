import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator } from "../../shared/i18n/index.ts";
import {
  createDesktopFileDialogAccess,
  type DesktopFileDialogAccessDependencies
} from "./desktopFileDialogAccess.ts";

test("desktop file dialog access localizes directory selection", async () => {
  const calls: Parameters<
    NonNullable<DesktopFileDialogAccessDependencies["showOpenDialog"]>
  >[] = [];
  const dialogAccess = createDesktopFileDialogAccess({
    getLocale: () => "en",
    showOpenDialog: async (...args) => {
      calls.push(args);
      return {
        canceled: false,
        filePaths: ["/tmp/demo"]
      };
    }
  });

  const selectedPath = await dialogAccess.selectDirectory();

  assert.equal(selectedPath, "/tmp/demo");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], undefined);
  assert.deepEqual(calls[0]?.[1], {
    buttonLabel: createTranslator("en").t("common.selectFolder"),
    properties: ["openDirectory"],
    title: createTranslator("en").t("common.selectFolder")
  });
});

test("desktop file dialog access returns empty selection for canceled uploads", async () => {
  const dialogAccess = createDesktopFileDialogAccess({
    getLocale: () => "en",
    showOpenDialog: async () => ({
      canceled: true,
      filePaths: ["/tmp/ignored"]
    })
  });

  const selectedPaths = await dialogAccess.selectUploadFiles();

  assert.deepEqual(selectedPaths, []);
});

test("desktop file dialog access selects app archive zip files", async () => {
  const calls: Parameters<
    NonNullable<DesktopFileDialogAccessDependencies["showOpenDialog"]>
  >[] = [];
  const dialogAccess = createDesktopFileDialogAccess({
    getLocale: () => "zh-CN",
    showOpenDialog: async (...args) => {
      calls.push(args);
      return {
        canceled: false,
        filePaths: ["/tmp/app.zip"]
      };
    }
  });

  const selectedPath = await dialogAccess.selectAppArchive();

  assert.equal(selectedPath, "/tmp/app.zip");
  assert.deepEqual(calls[0]?.[1], {
    filters: [
      {
        extensions: ["zip"],
        name: createTranslator("zh-CN").t("common.zipArchive")
      }
    ],
    properties: ["openFile"]
  });
});

test("desktop file dialog access selects app archive export path", async () => {
  const calls: Parameters<
    NonNullable<DesktopFileDialogAccessDependencies["showSaveDialog"]>
  >[] = [];
  const dialogAccess = createDesktopFileDialogAccess({
    getLocale: () => "en",
    showSaveDialog: async (...args) => {
      calls.push(args);
      return {
        canceled: false,
        filePath: "/tmp/export.zip"
      };
    }
  });

  const selectedPath =
    await dialogAccess.selectAppArchiveExportPath("sample.zip");

  assert.equal(selectedPath, "/tmp/export.zip");
  assert.deepEqual(calls[0]?.[1], {
    defaultPath: "sample.zip",
    filters: [
      {
        extensions: ["zip"],
        name: createTranslator("en").t("common.zipArchive")
      }
    ]
  });
});

test("desktop file dialog access returns selected upload paths", async () => {
  const calls: Parameters<
    NonNullable<DesktopFileDialogAccessDependencies["showOpenDialog"]>
  >[] = [];
  const dialogAccess = createDesktopFileDialogAccess({
    getLocale: () => "zh-CN",
    showOpenDialog: async (...args) => {
      calls.push(args);
      return {
        canceled: false,
        filePaths: ["/tmp/a.txt", "/tmp/folder"]
      };
    }
  });

  const selectedPaths = await dialogAccess.selectUploadFiles();

  assert.deepEqual(selectedPaths, ["/tmp/a.txt", "/tmp/folder"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.[1], {
    properties: ["openFile", "openDirectory", "multiSelections"]
  });
});

test("desktop file dialog access can disable directory upload selection", async () => {
  const calls: Parameters<
    NonNullable<DesktopFileDialogAccessDependencies["showOpenDialog"]>
  >[] = [];
  const dialogAccess = createDesktopFileDialogAccess({
    getLocale: () => "zh-CN",
    showOpenDialog: async (...args) => {
      calls.push(args);
      return {
        canceled: false,
        filePaths: ["/tmp/a.txt"]
      };
    }
  });

  const selectedPaths = await dialogAccess.selectUploadFiles(undefined, {
    allowDirectories: false
  });

  assert.deepEqual(selectedPaths, ["/tmp/a.txt"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.[1], {
    properties: ["openFile", "multiSelections"]
  });
});
