import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFilePreviewTarget } from "@tutti-os/workspace-file-preview";
import {
  coerceWorkspaceFilePreviewTarget,
  createWorkspaceFilePreviewInstanceID,
  createWorkspaceFilePreviewLaunchRequest,
  isWorkspaceFilePreviewTarget,
  workspaceTextFileNodeTypeID
} from "./workspaceFilePreviewLaunch.ts";

function textTarget(path: string): WorkspaceFilePreviewTarget {
  return {
    previewKind: "text",
    mtimeMs: null,
    name: path.split("/").pop() ?? "file.txt",
    path,
    sizeBytes: null
  };
}

test("workspace file preview instance ids are short stable path hashes", () => {
  const longPath = `/Users/example/${"nested-directory/".repeat(20)}notes.txt`;
  const target = textTarget(longPath);
  const instanceID = createWorkspaceFilePreviewInstanceID(target);

  assert.match(instanceID, /^path:[0-9a-f]{16}$/);
  assert.equal(instanceID, createWorkspaceFilePreviewInstanceID(target));
  assert.ok(!instanceID.includes(longPath));
  assert.ok(instanceID.length < 64);
});

test("workspace file preview instance ids distinguish file paths", () => {
  assert.notEqual(
    createWorkspaceFilePreviewInstanceID(textTarget("/workspace/a.txt")),
    createWorkspaceFilePreviewInstanceID(textTarget("/workspace/b.txt"))
  );
});

test("workspace file preview launch requests preserve the original file target", () => {
  const target = textTarget("/workspace/docs/spec.md");
  const request = createWorkspaceFilePreviewLaunchRequest(target);

  assert.equal(request.typeId, workspaceTextFileNodeTypeID);
  assert.equal(request.payload, target);
});

test("workspace file preview activation accepts video targets", () => {
  assert.equal(
    isWorkspaceFilePreviewTarget({
      previewKind: "video",
      mtimeMs: null,
      name: "demo.mp4",
      path: "/workspace/demo.mp4",
      sizeBytes: null
    }),
    true
  );
});

test("workspace file preview activation accepts shared targets without optional metadata", () => {
  assert.equal(
    isWorkspaceFilePreviewTarget({
      previewKind: "image",
      name: "cover.png",
      path: "/workspace/cover.png"
    }),
    true
  );
});

test("workspace file preview activation coerces legacy fileKind snapshots", () => {
  const legacy = {
    fileKind: "text",
    mtimeMs: null,
    name: "notes.md",
    path: "/workspace/notes.md",
    sizeBytes: 12
  };

  assert.equal(isWorkspaceFilePreviewTarget(legacy), false);
  assert.deepEqual(coerceWorkspaceFilePreviewTarget(legacy), {
    previewKind: "text",
    mtimeMs: null,
    name: "notes.md",
    path: "/workspace/notes.md",
    sizeBytes: 12
  });
});

test("workspace file preview activation coerces legacy video fileKind snapshots", () => {
  assert.deepEqual(
    coerceWorkspaceFilePreviewTarget({
      fileKind: "video",
      mtimeMs: null,
      name: "demo.mp4",
      path: "/workspace/demo.mp4",
      sizeBytes: null
    }),
    {
      previewKind: "video",
      mtimeMs: null,
      name: "demo.mp4",
      path: "/workspace/demo.mp4",
      sizeBytes: null
    }
  );
});
