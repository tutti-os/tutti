import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  filterOpenWithApplications,
  listOpenWithApplications,
  openFileWithApplication,
  openFileWithDefaultBrowser,
  parseListOpenWithApplicationsLine,
  pickOpenWithApplication,
  readDefaultApplicationIconDataUrl,
  resetOpenWithApplicationsCacheForTests
} from "./openWithApplications.ts";
import { resolveOpenWithApplicationIconOverrideDataUrl } from "../../shared/openWithApplicationIconOverrides.ts";

test("pickOpenWithApplication returns null on non-macOS", async (t) => {
  if (process.platform === "darwin") {
    t.skip("non-macOS only");
    return;
  }

  assert.equal(await pickOpenWithApplication(), null);
});

test("filterOpenWithApplications removes video players from text file handlers", async () => {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "tutti-open-with-filter-")
  );
  const quickTimePath = path.join(workspaceRoot, "QuickTime Player.app");
  const codePath = path.join(workspaceRoot, "Visual Studio Code.app");
  await mkdir(quickTimePath);
  await mkdir(codePath);

  assert.deepEqual(
    filterOpenWithApplications(
      [
        {
          applicationPath: quickTimePath,
          bundleIdentifier: "com.apple.QuickTimePlayerX",
          iconDataUrl: null,
          name: "QuickTime Player"
        },
        {
          applicationPath: codePath,
          bundleIdentifier: "com.microsoft.VSCode",
          iconDataUrl: null,
          name: "Visual Studio Code"
        }
      ],
      "/tmp/example.ts"
    ),
    [
      {
        applicationPath: codePath,
        bundleIdentifier: "com.microsoft.VSCode",
        iconDataUrl: null,
        name: "Visual Studio Code"
      }
    ]
  );
});

test("filterOpenWithApplications deduplicates by bundle id and skips inaccessible application paths", async () => {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "tutti-open-with-dedupe-")
  );
  const firstQuarkPath = path.join(workspaceRoot, "Quark.app");
  const duplicateQuarkPath = path.join(workspaceRoot, "Quark Copy.app");
  const textEditPath = path.join(workspaceRoot, "TextEdit.app");
  const missingPath = path.join(workspaceRoot, "Missing.app");
  await mkdir(firstQuarkPath);
  await mkdir(duplicateQuarkPath);
  await mkdir(textEditPath);

  assert.deepEqual(
    filterOpenWithApplications(
      [
        {
          applicationPath: firstQuarkPath,
          bundleIdentifier: "com.quark.browser",
          iconDataUrl: null,
          name: "Quark"
        },
        {
          applicationPath: duplicateQuarkPath,
          bundleIdentifier: "com.quark.browser",
          iconDataUrl: null,
          name: "Quark"
        },
        {
          applicationPath: missingPath,
          bundleIdentifier: "com.example.Missing",
          iconDataUrl: null,
          name: "Missing"
        },
        {
          applicationPath: textEditPath,
          bundleIdentifier: null,
          iconDataUrl: null,
          name: "TextEdit"
        }
      ],
      "/tmp/example.pdf"
    ),
    [
      {
        applicationPath: firstQuarkPath,
        bundleIdentifier: "com.quark.browser",
        iconDataUrl: null,
        name: "Quark"
      },
      {
        applicationPath: textEditPath,
        bundleIdentifier: null,
        iconDataUrl: null,
        name: "TextEdit"
      }
    ]
  );
});

test("open with application icons override Cursor and Antigravity", () => {
  assert.match(
    resolveOpenWithApplicationIconOverrideDataUrl({
      applicationPath: "/Applications/Cursor.app",
      name: "Cursor"
    }) ?? "",
    /^data:image\/png;base64,/
  );
  assert.match(
    resolveOpenWithApplicationIconOverrideDataUrl({
      applicationPath: "/Applications/Antigravity.app",
      name: "Antigravity"
    }) ?? "",
    /^data:image\/png;base64,/
  );
  assert.equal(
    resolveOpenWithApplicationIconOverrideDataUrl({
      applicationPath: "/Applications/TextEdit.app",
      name: "TextEdit"
    }),
    null
  );
});

test("parseListOpenWithApplicationsLine decodes workspace icon payloads", () => {
  assert.deepEqual(
    parseListOpenWithApplicationsLine(
      "Preview\t/System/Applications/Preview.app\tcom.apple.Preview\tYWJj"
    ),
    {
      applicationPath: "/System/Applications/Preview.app",
      bundleIdentifier: "com.apple.Preview",
      iconDataUrl: "data:image/png;base64,YWJj",
      name: "Preview"
    }
  );
  assert.deepEqual(
    parseListOpenWithApplicationsLine(
      "Preview\t/System/Applications/Preview.app\tcom.apple.Preview\t"
    ),
    {
      applicationPath: "/System/Applications/Preview.app",
      bundleIdentifier: "com.apple.Preview",
      iconDataUrl: null,
      name: "Preview"
    }
  );
  assert.deepEqual(
    parseListOpenWithApplicationsLine(
      "Preview\t/System/Applications/Preview.app\tYWJj"
    ),
    {
      applicationPath: "/System/Applications/Preview.app",
      bundleIdentifier: null,
      iconDataUrl: "data:image/png;base64,YWJj",
      name: "Preview"
    }
  );
  assert.deepEqual(
    parseListOpenWithApplicationsLine("Safari\t/Applications/Safari.app\t"),
    {
      applicationPath: "/Applications/Safari.app",
      bundleIdentifier: null,
      iconDataUrl: null,
      name: "Safari"
    }
  );
  assert.equal(parseListOpenWithApplicationsLine("invalid"), null);
});

test("listOpenWithApplications returns installed handlers on macOS", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS only");
    return;
  }

  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "tutti-open-with-list-")
  );
  const targetPath = path.join(workspaceRoot, "notes.txt");
  await writeFile(targetPath, "hello", "utf8");

  resetOpenWithApplicationsCacheForTests();
  const applications = await listOpenWithApplications(targetPath);
  assert.ok(applications.length > 0);
  assert.equal(
    applications.some((application) => /quicktime/i.test(application.name)),
    false
  );
  assert.ok(applications.every((application) => application.name.length > 0));
  assert.ok(
    applications.every((application) =>
      application.applicationPath.endsWith(".app")
    )
  );
  assert.ok(
    applications.some(
      (application) =>
        typeof application.iconDataUrl === "string" &&
        application.iconDataUrl.startsWith("data:image/png;base64,")
    )
  );
});

test("readDefaultApplicationIconDataUrl returns default handler icon on macOS", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS only");
    return;
  }

  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "tutti-default-app-icon-")
  );
  const targetPath = path.join(workspaceRoot, "notes.txt");
  await writeFile(targetPath, "hello", "utf8");

  resetOpenWithApplicationsCacheForTests();
  const iconDataUrl = await readDefaultApplicationIconDataUrl(targetPath);
  if (!iconDataUrl) {
    t.skip("default application icon unavailable in this test environment");
    return;
  }

  assert.match(iconDataUrl, /^data:image\/png;base64,/);
});

test("openFileWithDefaultBrowser delegates to the macOS browser opener without launching it in tests", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS only");
    return;
  }

  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "tutti-open-with-default-browser-")
  );
  const targetPath = path.join(workspaceRoot, "notes.html");
  await writeFile(targetPath, "<html></html>", "utf8");
  const calls: Array<{ args?: readonly string[]; file: string }> = [];

  await openFileWithDefaultBrowser(targetPath, {
    execFile: async (file, args) => {
      calls.push({ args, file });
      return { stderr: "", stdout: "" };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "swift");
  assert.ok(calls[0]?.args?.[0]?.endsWith("openFileWithDefaultBrowser.swift"));
  assert.equal(calls[0]?.args?.[1], path.resolve(targetPath));
});

test("openFileWithApplication delegates to macOS open without launching the application in tests", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS only");
    return;
  }

  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "tutti-open-with-open-")
  );
  const targetPath = path.join(workspaceRoot, "notes.txt");
  const applicationPath = path.join(workspaceRoot, "TextEdit.app");
  await writeFile(targetPath, "hello", "utf8");
  await mkdir(applicationPath);
  const calls: Array<{ args?: readonly string[]; file: string }> = [];

  await openFileWithApplication(targetPath, applicationPath, {
    execFile: async (file, args) => {
      calls.push({ args, file });
      return { stderr: "", stdout: "" };
    }
  });

  assert.deepEqual(calls, [
    {
      file: "open",
      args: ["-a", path.resolve(applicationPath), path.resolve(targetPath)]
    }
  ]);
});
