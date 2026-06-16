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

test("skips icon resolution for regular image files", () => {
  assert.equal(
    shouldResolveWorkspaceFileEntryIcon(
      createEntry({ name: "photo.png", path: "/workspace/photo.png" })
    ),
    false
  );
});

test("resolves image thumbnails only when enabled", () => {
  const entry = createEntry({
    mtimeMs: 42,
    name: "photo.png",
    path: "/workspace/photo.png"
  });

  assert.equal(
    shouldResolveWorkspaceFileEntryIcon(entry, {
      includeImageThumbnails: true
    }),
    true
  );
  assert.equal(
    resolveWorkspaceFileEntryIconCacheKey(entry),
    "image-thumbnail:/workspace/photo.png:42"
  );
});

test("uses extension document icons for text, code, and archive files", () => {
  for (const name of [
    "example.txt",
    "index.html",
    "README.md",
    "brief.pdf",
    "Archive.zip",
    "backup.tar",
    "bundle.7z"
  ]) {
    const entry = createEntry({ name, path: `/workspace/${name}` });
    assert.equal(shouldUseWorkspaceFileExtensionDocumentIcon(entry), true);
    assert.equal(shouldResolveWorkspaceFileEntryIcon(entry), false);
  }
});

test("resolves default application icons for selected document-like file types", () => {
  for (const name of ["Deck.pptx", "Design.psd"]) {
    assert.equal(
      shouldResolveWorkspaceFileEntryIcon(
        createEntry({ name, path: `/workspace/${name}` })
      ),
      true
    );
  }
});

test("skips icon resolution for media files and regular directories", () => {
  assert.equal(
    shouldResolveWorkspaceFileEntryIcon(
      createEntry({ name: "clip.mp4", path: "/workspace/clip.mp4" })
    ),
    false
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

test("resolves icons for non-file application bundles by name", () => {
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
  assert.equal(
    shouldResolveWorkspaceFileEntryIcon(
      createEntry({
        kind: "file",
        name: "Fake.app",
        path: "/workspace/Fake.app"
      })
    ),
    false
  );
});

test("builds cache keys by icon target kind", () => {
  assert.equal(
    resolveWorkspaceFileEntryIconCacheKey(
      createEntry({
        kind: "unknown",
        mtimeMs: 42,
        name: "Demo.app",
        path: "/workspace/Demo.app"
      })
    ),
    "application:/workspace/Demo.app:42"
  );
  assert.equal(
    resolveWorkspaceFileEntryIconCacheKey(
      createEntry({
        mtimeMs: 42,
        name: "Deck.pptx",
        path: "/workspace/Deck.pptx"
      })
    ),
    "file-type-default-application:pptx"
  );
});
