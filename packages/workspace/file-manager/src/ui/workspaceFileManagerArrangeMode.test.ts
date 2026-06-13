import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";
import {
  readWorkspaceFileManagerArrangeMode,
  sortWorkspaceFileEntriesForArrangeMode,
  workspaceFileManagerArrangeModeStorageKey,
  writeWorkspaceFileManagerArrangeMode
} from "./workspaceFileManagerArrangeMode.ts";

function createEntry(
  overrides: Partial<WorkspaceFileEntry> = {}
): WorkspaceFileEntry {
  return {
    createdTimeMs: 1_690_000_000_000,
    hasChildren: false,
    kind: "file",
    lastOpenedMs: 1_710_000_000_000,
    mtimeMs: 1_700_000_000_000,
    name: "example.txt",
    path: "/workspace/example.txt",
    sizeBytes: 128,
    ...overrides
  };
}

test("workspace file manager arrange mode defaults to none", () => {
  assert.equal(readWorkspaceFileManagerArrangeMode(), "none");
});

test("workspace file manager arrange mode persists selected mode", () => {
  const storage = new Map<string, string>();
  const originalWindow = globalThis.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        }
      }
    }
  });

  try {
    writeWorkspaceFileManagerArrangeMode("kind");
    assert.equal(
      storage.get(workspaceFileManagerArrangeModeStorageKey),
      "kind"
    );
    assert.equal(readWorkspaceFileManagerArrangeMode(), "kind");
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow
    });
  }
});

test("workspace file manager arrange mode sorts by name with directories first", () => {
  const entries = [
    createEntry({ name: "zeta.txt", path: "/workspace/zeta.txt" }),
    createEntry({ kind: "directory", name: "src", path: "/workspace/src" }),
    createEntry({ name: "alpha.txt", path: "/workspace/alpha.txt" })
  ];

  assert.deepEqual(
    sortWorkspaceFileEntriesForArrangeMode(entries, "name").map(
      (entry) => entry.name
    ),
    ["src", "alpha.txt", "zeta.txt"]
  );
});

test("workspace file manager arrange mode sorts by size descending without forcing directories first", () => {
  const entries = [
    createEntry({ name: "small.txt", sizeBytes: 4 }),
    createEntry({ name: "large.txt", sizeBytes: 1024 }),
    createEntry({ kind: "directory", name: "src", path: "/workspace/src" })
  ];

  assert.deepEqual(
    sortWorkspaceFileEntriesForArrangeMode(entries, "size").map(
      (entry) => entry.name
    ),
    ["large.txt", "src", "small.txt"]
  );
});

test("workspace file manager arrange mode sorts modified files before older directories", () => {
  const entries = [
    createEntry({
      kind: "directory",
      mtimeMs: 1_700_000_000_000,
      name: "config",
      path: "/workspace/config"
    }),
    createEntry({
      mtimeMs: 1_800_000_000_000,
      name: "5.txt",
      path: "/workspace/5.txt"
    }),
    createEntry({
      mtimeMs: 1_600_000_000_000,
      name: "aa.txt",
      path: "/workspace/aa.txt"
    })
  ];

  assert.deepEqual(
    sortWorkspaceFileEntriesForArrangeMode(entries, "modified").map(
      (entry) => entry.name
    ),
    ["5.txt", "config", "aa.txt"]
  );
});

test("workspace file manager arrange mode sorts created dates independently from modified dates", () => {
  const entries = [
    createEntry({
      createdTimeMs: 1_900_000_000_000,
      mtimeMs: 1_600_000_000_000,
      name: "newly-created.txt",
      path: "/workspace/newly-created.txt"
    }),
    createEntry({
      createdTimeMs: 1_500_000_000_000,
      mtimeMs: 1_800_000_000_000,
      name: "recently-modified.txt",
      path: "/workspace/recently-modified.txt"
    })
  ];

  assert.deepEqual(
    sortWorkspaceFileEntriesForArrangeMode(entries, "created").map(
      (entry) => entry.name
    ),
    ["newly-created.txt", "recently-modified.txt"]
  );
  assert.deepEqual(
    sortWorkspaceFileEntriesForArrangeMode(entries, "modified").map(
      (entry) => entry.name
    ),
    ["recently-modified.txt", "newly-created.txt"]
  );
});

test("workspace file manager arrange mode sorts last opened dates independently", () => {
  const entries = [
    createEntry({
      lastOpenedMs: 1_500_000_000_000,
      mtimeMs: 1_900_000_000_000,
      name: "recently-modified.txt",
      path: "/workspace/recently-modified.txt"
    }),
    createEntry({
      lastOpenedMs: 1_800_000_000_000,
      mtimeMs: 1_600_000_000_000,
      name: "recently-opened.txt",
      path: "/workspace/recently-opened.txt"
    })
  ];

  assert.deepEqual(
    sortWorkspaceFileEntriesForArrangeMode(entries, "lastOpened").map(
      (entry) => entry.name
    ),
    ["recently-opened.txt", "recently-modified.txt"]
  );
});
