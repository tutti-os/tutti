import assert from "node:assert/strict";
import test from "node:test";
import {
  isWorkspaceFileBrowserOpenable,
  shouldFilterVideoPlayersForOpenWith
} from "./openWithPolicy.ts";

test("open-with policy filters video players for code and text targets", () => {
  assert.equal(
    shouldFilterVideoPlayersForOpenWith({
      kind: "file",
      path: "/workspace/src/App.tsx"
    }),
    true
  );
  assert.equal(
    shouldFilterVideoPlayersForOpenWith({
      kind: "file",
      path: "/workspace/config.json"
    }),
    true
  );
  assert.equal(
    shouldFilterVideoPlayersForOpenWith({
      kind: "file",
      path: "/workspace/transport.ts"
    }),
    true
  );
  assert.equal(
    shouldFilterVideoPlayersForOpenWith({
      kind: "file",
      path: "/workspace/README.md"
    }),
    true
  );
  assert.equal(
    shouldFilterVideoPlayersForOpenWith({
      kind: "file",
      path: "/workspace/clip.mp4"
    }),
    false
  );
  assert.equal(
    shouldFilterVideoPlayersForOpenWith({
      kind: "file",
      path: "/workspace/clip.mts"
    }),
    false
  );
  assert.equal(
    shouldFilterVideoPlayersForOpenWith({
      kind: "file",
      path: "/workspace/archive.zip"
    }),
    false
  );
});

test("open-with policy identifies browser-openable files", () => {
  assert.equal(
    isWorkspaceFileBrowserOpenable({
      kind: "file",
      path: "/workspace/index.html"
    }),
    true
  );
  assert.equal(
    isWorkspaceFileBrowserOpenable({
      kind: "file",
      path: "/workspace/report.pdf"
    }),
    true
  );
  assert.equal(
    isWorkspaceFileBrowserOpenable({
      kind: "file",
      path: "/workspace/logo.png"
    }),
    true
  );
  assert.equal(
    isWorkspaceFileBrowserOpenable({
      kind: "file",
      path: "/workspace/demo.mp4"
    }),
    true
  );
  assert.equal(
    isWorkspaceFileBrowserOpenable({
      kind: "file",
      path: "/workspace/config.json"
    }),
    true
  );
  assert.equal(
    isWorkspaceFileBrowserOpenable({
      kind: "file",
      path: "/workspace/README"
    }),
    true
  );
  assert.equal(
    isWorkspaceFileBrowserOpenable({
      kind: "directory",
      path: "/workspace/docs"
    }),
    false
  );
  assert.equal(
    isWorkspaceFileBrowserOpenable({
      kind: "file",
      path: "/workspace/archive.zip"
    }),
    false
  );
});
