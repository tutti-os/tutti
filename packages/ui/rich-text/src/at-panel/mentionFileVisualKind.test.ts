import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveMentionFileThumbnailUrl,
  resolveMentionFileVisualKind
} from "./mentionFileVisualKind.ts";

test("resolveMentionFileVisualKind: every folder back action overrides base kind", () => {
  for (const mentionNavigation of [
    "agent-generated-folder-back",
    "workspace-folder-back"
  ]) {
    assert.equal(
      resolveMentionFileVisualKind({
        mentionNavigation,
        baseVisualKind: "document"
      }),
      "back"
    );
  }
});

test("resolveMentionFileVisualKind: directory entry resolves to folder", () => {
  assert.equal(
    resolveMentionFileVisualKind({
      entryKind: "directory",
      baseVisualKind: "code"
    }),
    "folder"
  );
});

test("resolveMentionFileVisualKind: falls back to the base visual kind", () => {
  assert.equal(
    resolveMentionFileVisualKind({ baseVisualKind: "image" }),
    "image"
  );
});

test("resolveMentionFileThumbnailUrl: only images with a url get a thumbnail", () => {
  assert.equal(
    resolveMentionFileThumbnailUrl({
      visualKind: "image",
      thumbnailUrl: " data:image/png;base64,thumb "
    }),
    "data:image/png;base64,thumb"
  );
  assert.equal(
    resolveMentionFileThumbnailUrl({
      visualKind: "document",
      thumbnailUrl: "data:image/png;base64,thumb"
    }),
    undefined
  );
  assert.equal(
    resolveMentionFileThumbnailUrl({ visualKind: "image", thumbnailUrl: "  " }),
    undefined
  );
});
