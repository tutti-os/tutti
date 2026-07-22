import assert from "node:assert/strict";
import test from "node:test";
import {
  filterVisibleWorkspaceEntries,
  formatWorkspaceFileModifiedTime,
  normalizeWorkspaceFilePath,
  resolveWorkspaceFileActivationTarget,
  sortWorkspaceEntries,
  validateWorkspaceFileEntryName,
  workspaceFileDirectory,
  workspaceFilePathHasHiddenSegment
} from "./workspaceFileManagerModel.ts";
import type { WorkspaceFileEntry } from "./workspaceFileManagerTypes.ts";

test("normalizes paths under the logical workspace root", () => {
  assert.equal(
    normalizeWorkspaceFilePath("src/../README.md", "/Users/demo/project"),
    "/Users/demo/project/README.md"
  );
  assert.equal(
    normalizeWorkspaceFilePath("/Users/demo/project/src/"),
    "/Users/demo/project/src"
  );
  assert.equal(normalizeWorkspaceFilePath(""), "/");
});

test("normalizes Windows drive paths without treating them as relative", () => {
  assert.equal(
    normalizeWorkspaceFilePath("src\\main.ts", "C:\\Users\\demo\\project"),
    "C:/Users/demo/project/src/main.ts"
  );
  assert.equal(
    normalizeWorkspaceFilePath(
      "C:\\tmp\\report.txt",
      "C:\\Users\\demo\\project"
    ),
    "C:/tmp/report.txt"
  );
});

test("formatWorkspaceFileModifiedTime uses the shared English short date-time format", () => {
  const timestamp = new Date(2026, 4, 23, 11, 39).getTime();

  assert.equal(formatWorkspaceFileModifiedTime(timestamp), "May 23, 11:39");
});

test("formatWorkspaceFileModifiedTime uses Chinese date copy for zh-CN", () => {
  const timestamp = new Date(2026, 4, 23, 11, 39).getTime();

  assert.equal(
    formatWorkspaceFileModifiedTime(timestamp, "zh-CN"),
    "5月23日 11:39"
  );
});

test("derives logical parent directory", () => {
  assert.equal(
    workspaceFileDirectory(
      "/Users/demo/project/src/main.ts",
      "/Users/demo/project"
    ),
    "/Users/demo/project/src"
  );
  assert.equal(
    workspaceFileDirectory(
      "/Users/demo/project/main.ts",
      "/Users/demo/project"
    ),
    "/Users/demo/project"
  );
});

test("derives external absolute parent directories outside the current root", () => {
  assert.equal(
    workspaceFileDirectory("/tmp/hello_world.md", "/Users/demo"),
    "/tmp"
  );
  assert.equal(workspaceFileDirectory("/hello_world.md", "/Users/demo"), "/");
  assert.equal(
    workspaceFileDirectory(
      "/var/folders/demo/T/codex-presentations/slides.pptx",
      "/Users/demo"
    ),
    "/var/folders/demo/T/codex-presentations"
  );
  assert.equal(
    workspaceFileDirectory("../../tmp/file.txt", "/Users/demo"),
    "/Users/demo"
  );
});

test("derives Windows drive parent directories outside the current root", () => {
  assert.equal(
    workspaceFileDirectory("C:\\tmp\\hello_world.md", "C:\\Users\\demo"),
    "C:/tmp"
  );
  assert.equal(
    workspaceFileDirectory("C:\\hello_world.md", "C:\\Users\\demo"),
    "C:/"
  );
});

test("filters hidden directories and sorts directories first", () => {
  const entries: WorkspaceFileEntry[] = [
    entry("zeta.txt", "file"),
    entry(".git", "directory"),
    entry("src", "directory"),
    entry("alpha.txt", "file")
  ];

  assert.deepEqual(
    sortWorkspaceEntries(filterVisibleWorkspaceEntries(entries)).map(
      (candidate) => candidate.name
    ),
    ["src", "alpha.txt", "zeta.txt"]
  );
});

test("detects paths inside hidden directory segments", () => {
  assert.equal(
    workspaceFilePathHasHiddenSegment(
      "/Users/demo/.tutti-dev/agent/runs/image.png"
    ),
    true
  );
  assert.equal(
    workspaceFilePathHasHiddenSegment("/Users/demo/project/.cache/image.png"),
    true
  );
  assert.equal(
    workspaceFilePathHasHiddenSegment("/Users/demo/project/src/image.png"),
    false
  );
});

test("validates file and directory names for dialogs", () => {
  assert.equal(validateWorkspaceFileEntryName(""), "required");
  assert.equal(validateWorkspaceFileEntryName(".."), "invalid");
  assert.equal(validateWorkspaceFileEntryName("src/app"), "invalid");
  assert.equal(validateWorkspaceFileEntryName("notes.md"), null);
});

test("resolves previewable files into activation targets", () => {
  const markdownEntry = entry("README.md", "file");
  markdownEntry.sizeBytes = 128;

  assert.deepEqual(resolveWorkspaceFileActivationTarget(markdownEntry), {
    fileKind: "text",
    mtimeMs: null,
    name: "README.md",
    path: "/Users/demo/project/README.md",
    sizeBytes: 128
  });

  const archiveEntry = entry("archive.zip", "file");
  assert.equal(resolveWorkspaceFileActivationTarget(archiveEntry), null);
});

function entry(
  name: string,
  kind: WorkspaceFileEntry["kind"]
): WorkspaceFileEntry {
  return {
    hasChildren: false,
    kind,
    mtimeMs: null,
    name,
    path: `/Users/demo/project/${name}`,
    sizeBytes: kind === "directory" ? null : 0
  };
}
