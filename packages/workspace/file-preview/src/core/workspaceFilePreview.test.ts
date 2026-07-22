import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWorkspaceFilePreviewKind,
  createWorkspaceFilePreviewLoadedState,
  decodeWorkspaceTextFile,
  formatWorkspacePreviewByteLimit,
  looksLikeBinaryText,
  resolveWorkspaceFileBuiltinRenderKind,
  resolveWorkspaceFilePreviewTarget,
  resolveWorkspaceFilePreviewReadiness,
  resolveWorkspaceFileVisualKind,
  resolveWorkspaceImageMimeType
} from "./workspaceFilePreview.ts";

test("workspace file preview classifies the flat previewKind taxonomy", () => {
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
      path: "/workspace/guide.md"
    }),
    "markdown"
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "file",
      path: "/workspace/app.ts"
    }),
    "code"
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "file",
      path: "/workspace/data.json"
    }),
    "json"
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "file",
      path: "/workspace/index.html"
    }),
    "html"
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "file",
      path: "/workspace/track.mp3"
    }),
    "audio"
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "file",
      path: "/workspace/report.pdf"
    }),
    "pdf"
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "directory",
      path: "/workspace/docs"
    }),
    "directory"
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "folder",
      path: "/workspace/docs"
    }),
    "directory"
  );
  assert.equal(
    classifyWorkspaceFilePreviewKind({
      kind: "file",
      path: "/workspace/archive.zip"
    }),
    "unsupported"
  );
});

test("workspace file preview resolves builtin-presentable targets", () => {
  assert.deepEqual(
    resolveWorkspaceFilePreviewTarget({
      kind: "file",
      mtimeMs: 1,
      name: "guide.md",
      path: "/workspace/guide.md",
      sizeBytes: 32
    }),
    {
      previewKind: "markdown",
      mtimeMs: 1,
      name: "guide.md",
      path: "/workspace/guide.md",
      sizeBytes: 32
    }
  );
  assert.equal(
    resolveWorkspaceFilePreviewTarget({
      kind: "file",
      path: "/workspace/report.pdf"
    }),
    null
  );
  assert.equal(resolveWorkspaceFileBuiltinRenderKind("markdown"), "text");
  assert.equal(resolveWorkspaceFileBuiltinRenderKind("pdf"), null);
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
        previewKind: "image",
        name: "image.png",
        path: "/workspace/image.png"
      }
    }),
    {
      bytes: new Uint8Array([0x89, 0x50]),
      contentType: "image/png",
      entry: {
        previewKind: "image",
        name: "image.png",
        path: "/workspace/image.png"
      },
      previewKind: "image",
      status: "image"
    }
  );

  assert.deepEqual(
    createWorkspaceFilePreviewLoadedState({
      bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18]),
      contentType: "video/mp4",
      entry: { kind: "file", path: "/workspace/demo.mp4" },
      target: {
        previewKind: "video",
        name: "demo.mp4",
        path: "/workspace/demo.mp4"
      }
    }),
    {
      bytes: new Uint8Array([0x00, 0x00, 0x00, 0x18]),
      contentType: "video/mp4",
      entry: {
        previewKind: "video",
        name: "demo.mp4",
        path: "/workspace/demo.mp4"
      },
      previewKind: "video",
      status: "video"
    }
  );

  assert.deepEqual(
    createWorkspaceFilePreviewLoadedState({
      bytes: new TextEncoder().encode("hello"),
      entry: { kind: "file", path: "/workspace/readme.md" },
      target: {
        previewKind: "markdown",
        name: "readme.md",
        path: "/workspace/readme.md"
      }
    }),
    {
      content: "hello",
      entry: {
        previewKind: "markdown",
        name: "readme.md",
        path: "/workspace/readme.md"
      },
      previewKind: "markdown",
      status: "text"
    }
  );
  assert.deepEqual(
    createWorkspaceFilePreviewLoadedState({
      bytes: new Uint8Array([0xff]),
      entry: { kind: "file", path: "/workspace/readme.md" },
      target: {
        previewKind: "markdown",
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
  assert.deepEqual(
    createWorkspaceFilePreviewLoadedState({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "application/pdf",
      preferHostBytes: true,
      entry: { kind: "file", path: "/workspace/report.pdf" },
      target: {
        previewKind: "pdf",
        name: "report.pdf",
        path: "/workspace/report.pdf"
      }
    }),
    {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "application/pdf",
      entry: {
        previewKind: "pdf",
        name: "report.pdf",
        path: "/workspace/report.pdf"
      },
      previewKind: "pdf",
      status: "bytes"
    }
  );
});

test("workspace file preview treats html as source text by default", () => {
  assert.deepEqual(
    createWorkspaceFilePreviewLoadedState({
      bytes: new TextEncoder().encode("<!doctype html><h1>Hello</h1>"),
      entry: { kind: "file", path: "/workspace/index.html" },
      target: {
        previewKind: "html",
        name: "index.html",
        path: "/workspace/index.html"
      }
    }),
    {
      content: "<!doctype html><h1>Hello</h1>",
      entry: {
        previewKind: "html",
        name: "index.html",
        path: "/workspace/index.html"
      },
      previewKind: "html",
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
      previewKind: "unsupported",
      status: "unsupported"
    }
  );
  assert.deepEqual(
    resolveWorkspaceFilePreviewReadiness({
      kind: "file",
      path: "/workspace/report.pdf"
    }),
    {
      entry: {
        kind: "file",
        path: "/workspace/report.pdf"
      },
      previewKind: "pdf",
      status: "unsupported"
    }
  );
  assert.deepEqual(
    resolveWorkspaceFilePreviewReadiness(
      {
        kind: "file",
        path: "/workspace/report.pdf"
      },
      { hasHostRenderer: (kind) => kind === "pdf" }
    ),
    {
      entry: {
        kind: "file",
        path: "/workspace/report.pdf"
      },
      status: "ready",
      target: {
        previewKind: "pdf",
        name: "report.pdf",
        path: "/workspace/report.pdf"
      }
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
        previewKind: "image",
        name: "image.png",
        path: "/workspace/image.png",
        sizeBytes: 12
      }
    }
  );
});
