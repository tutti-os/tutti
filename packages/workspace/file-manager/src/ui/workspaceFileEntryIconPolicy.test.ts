import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";
import {
  resolveWorkspaceFileEntryIconCacheKey,
  shouldResolveWorkspaceFileEntryIcon,
  shouldUseWorkspaceFileExtensionDocumentIcon
} from "./workspaceFileEntryIconPolicy.ts";

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

test("resolves icons for image files", () => {
  assert.equal(
    shouldResolveWorkspaceFileEntryIcon(
      createEntry({ name: "photo.png", path: "/workspace/photo.png" })
    ),
    true
  );
});

test("uses extension document icons for text and code files", () => {
  for (const name of ["example.txt", "index.html", "README.md"]) {
    const entry = createEntry({ name, path: `/workspace/${name}` });
    assert.equal(shouldUseWorkspaceFileExtensionDocumentIcon(entry), true);
    assert.equal(shouldResolveWorkspaceFileEntryIcon(entry), false);
  }
});

test("resolves icons for non-text regular files and skips regular directories", () => {
  assert.equal(
    shouldResolveWorkspaceFileEntryIcon(
      createEntry({ name: "brief.pdf", path: "/workspace/brief.pdf" })
    ),
    true
  );
  assert.equal(
    shouldResolveWorkspaceFileEntryIcon(
      createEntry({
        kind: "directory",
        name: "src",
        path: "/workspace/src"
      })
    ),
    false
  );
});

test("resolves icons for application bundles by name", () => {
  assert.equal(
    shouldResolveWorkspaceFileEntryIcon(
      createEntry({
        kind: "unknown",
        name: "Zoom.app",
        path: "/workspace/Zoom.app"
      })
    ),
    true
  );
});

test("builds cache keys from path and mtime", () => {
  assert.equal(
    resolveWorkspaceFileEntryIconCacheKey(
      createEntry({
        mtimeMs: 42,
        path: "/workspace/a.png"
      })
    ),
    "/workspace/a.png:42"
  );
});
