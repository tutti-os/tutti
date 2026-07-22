import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWorkspaceFilePreviewKind,
  createWorkspaceFilePreviewLoadedState,
  decodeWorkspaceTextFile,
  formatWorkspacePreviewByteLimit,
  looksLikeBinaryText,
  isWorkspaceFileBrowserOpenable,
  shouldFilterVideoPlayersForOpenWith,
  resolveWorkspaceFileActivationTarget,
  resolveWorkspaceFilePreviewReadiness,
  resolveWorkspaceFileVisualKind,
  resolveWorkspaceImageMimeType
} from "./workspaceFilePreview.ts";

test("workspace file preview classifies previewable files", () => {
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "file",
      name: "README",
      path: "/workspace/README"
    }),
    "text"
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "file",
      path: "/workspace/design.png"
    }),
    "image"
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "file",
      path: "/workspace/demo.mp4"
    }),
    "video"
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "file",
      path: "/workspace/demo.webm"
    }),
    "video"
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "folder",
      path: "/workspace/docs"
    }),
    null
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "file",
      path: "/workspace/archive.zip"
    }),
    null
  );
});

test("workspace file preview resolves activation targets and display kinds", () => {
  assert.deepEqual(
    resolveWorkspaceFileActivationTarget({
      kind: "file",
      mtimeMs: 1,
      name: "guide.md",
      path: "/workspace/guide.md",
      sizeBytes: 32
    }),
    {
      fileKind: "text",
      mtimeMs: 1,
      name: "guide.md",
      path: "/workspace/guide.md",
      sizeBytes: 32
    }
  );
  assert.equal(
    resolveWorkspaceFileVisualKind({
      kind: "directory",
      name: "src",
      path: "/workspace/src"
    }),
    "directory"
  );
  assert.equal(
    resolveWorkspaceFileVisualKind({
      kind: "file",
      name: "app.ts",
      path: "/workspace/app.ts"
    }),
    "code"
  );
});

test("workspace file preview decodes bytes and formats limits", () => {
  assert.equal(resolveWorkspaceImageMimeType("diagram.svg"), "image/svg+xml");
  assert.equal(decodeWorkspaceTextFile(new Uint8Array([0x68, 0x69])), "hi");
  assert.equal(looksLikeBinaryText("plain text"), false);
  assert.equal(looksLikeBinaryText("a\u0000b"), true);
  assert.equal(formatWorkspacePreviewByteLimit(1024 * 1024), "1 MiB");
});

test("workspace file preview creates loaded image, video, text, and readonly states", () => {
  assert.deepEqual(
    createWorkspaceFilePreviewLoadedState({
      bytes: new Uint8Array([0x89, 0x50]),
      entry: { kind: "file", path: "/workspace/image.png" },
      target: {
        fileKind: "image",
        name: "image.png",
        path: "/workspace/image.png"
      }
    }),
    {
      bytes: new Uint8Array([0x89, 0x50]),
      contentType: "image/png",
      entry: {
        fileKind: "image",
        name: "image.png",
        path: "/workspace/image.png"
      },
      status: "image"
    }
  );

  assert.deepEqual(
    createWorkspaceFilePreviewLoadedState({
      bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18]),
      contentType: "video/mp4",
      entry: { kind: "file", path: "/workspace/demo.mp4" },
      target: {
        fileKind: "video",
        name: "demo.mp4",
        path: "/workspace/demo.mp4"
      }
    }),
    {
      bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18]),
      contentType: "video/mp4",
      entry: {
        fileKind: "video",
        name: "demo.mp4",
        path: "/workspace/demo.mp4"
      },
      status: "video"
    }
  );

  assert.deepEqual(
    createWorkspaceFilePreviewLoadedState({
      bytes: new TextEncoder().encode("hello"),
      entry: { kind: "file", path: "/workspace/readme.md" },
      target: {
        fileKind: "text",
        name: "readme.md",
        path: "/workspace/readme.md"
      }
    }),
    {
      content: "hello",
      entry: {
        fileKind: "text",
        name: "readme.md",
        path: "/workspace/readme.md"
      },
      status: "text"
    }
  );
  assert.deepEqual(
    createWorkspaceFilePreviewLoadedState({
      bytes: new Uint8Array([0xff]),
      entry: { kind: "file", path: "/workspace/readme.md" },
      target: {
        fileKind: "text",
        name: "readme.md",
        path: "/workspace/readme.md"
      }
    }),
    {
      entry: { kind: "file", path: "/workspace/readme.md" },
      reason: "decode_failed",
      status: "readonly"
    }
  );
});

test("workspace file preview treats html as source text", () => {
  assert.deepEqual(
    createWorkspaceFilePreviewLoadedState({
      bytes: new TextEncoder().encode("<!doctype html><h1>Hello</h1>"),
      entry: { kind: "file", path: "/workspace/index.html" },
      target: {
        fileKind: "text",
        name: "index.html",
        path: "/workspace/index.html"
      }
    }),
    {
      content: "<!doctype html><h1>Hello</h1>",
      entry: {
        fileKind: "text",
        name: "index.html",
        path: "/workspace/index.html"
      },
      status: "text"
    }
  );
});

test("workspace file preview resolves readiness before reading bytes", () => {
  assert.deepEqual(
    resolveWorkspaceFilePreviewReadiness({
      kind: "directory",
      path: "/workspace/src"
    }),
    {
      entry: {
        kind: "directory",
        path: "/workspace/src"
      },
      status: "directory"
    }
  );
  assert.deepEqual(
    resolveWorkspaceFilePreviewReadiness({
      kind: "file",
      path: "/workspace/archive.zip"
    }),
    {
      entry: {
        kind: "file",
        path: "/workspace/archive.zip"
      },
      status: "unsupported"
    }
  );
  assert.deepEqual(
    resolveWorkspaceFilePreviewReadiness({
      kind: "file",
      path: "/workspace/readme.md",
      sizeBytes: 1024 * 1024 + 1
    }),
    {
      entry: {
        kind: "file",
        path: "/workspace/readme.md",
        sizeBytes: 1024 * 1024 + 1
      },
      maxSizeBytes: 1024 * 1024,
      reason: "text_too_large",
      status: "readonly"
    }
  );
  assert.deepEqual(
    resolveWorkspaceFilePreviewReadiness({
      kind: "file",
      path: "/workspace/image.png",
      sizeBytes: 12
    }),
    {
      entry: {
        kind: "file",
        path: "/workspace/image.png",
        sizeBytes: 12
      },
      status: "ready",
      target: {
        fileKind: "image",
        name: "image.png",
        path: "/workspace/image.png",
        sizeBytes: 12
      }
    }
  );
});

test("workspace file preview filters video players for code and text open-with targets", () => {
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

test("workspace file preview identifies browser-openable files", () => {
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
