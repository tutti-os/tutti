import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceFilePreviewController,
  type WorkspaceFilePreviewObjectUrlFactory,
  type WorkspaceFilePreviewReadResult
} from "./workspaceFilePreviewController.ts";

interface TestEntry {
  kind: "directory" | "file";
  mtimeMs?: number;
  path: string;
  sizeBytes?: number;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createObjectUrls() {
  let nextID = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const factory: WorkspaceFilePreviewObjectUrlFactory = {
    create() {
      const value = `blob:test-${++nextID}`;
      created.push(value);
      return value;
    },
    revoke(value) {
      revoked.push(value);
    }
  };
  return { created, factory, revoked };
}

function createDeferredRead() {
  const reads: Array<{
    path: string;
    resolve: (value: WorkspaceFilePreviewReadResult) => void;
    signal: AbortSignal;
  }> = [];
  return {
    read: ({ entry, signal }: { entry: TestEntry; signal: AbortSignal }) =>
      new Promise<WorkspaceFilePreviewReadResult>((resolve) => {
        reads.push({ path: entry.path, resolve, signal });
      }),
    reads
  };
}

function createController(input?: {
  objectUrls?: WorkspaceFilePreviewObjectUrlFactory;
  read?: (input: {
    entry: TestEntry;
    signal: AbortSignal;
  }) => Promise<WorkspaceFilePreviewReadResult | null>;
}) {
  return createWorkspaceFilePreviewController<TestEntry>({
    objectUrls: input?.objectUrls,
    read: input?.read,
    toPreviewEntry: (entry) => entry
  });
}

test("preview controller resolves empty, directory, unsupported, and readonly entries without reading", () => {
  let reads = 0;
  const controller = createController({
    read: async () => {
      reads += 1;
      return { bytes: new Uint8Array() };
    }
  });

  controller.setEntry({ kind: "directory", path: "/workspace/src" });
  assert.equal(controller.getSnapshot().status, "directory");
  controller.setEntry({ kind: "file", path: "/workspace/archive.zip" });
  assert.deepEqual(controller.getSnapshot(), {
    entry: { kind: "file", path: "/workspace/archive.zip" },
    reason: "file_type",
    status: "unsupported"
  });
  controller.setEntry({
    kind: "file",
    path: "/workspace/readme.md",
    sizeBytes: 1024 * 1024 + 1
  });
  assert.equal(controller.getSnapshot().status, "readonly");
  controller.setEntry(null);
  assert.deepEqual(controller.getSnapshot(), { status: "empty" });
  assert.equal(reads, 0);
});

test("preview controller loads text and reports reader errors without localizing them", async () => {
  const failure = new Error("read failed");
  const controller = createController({
    read: async ({ entry }) => {
      if (entry.path.endsWith("fail.md")) {
        throw failure;
      }
      return { bytes: new TextEncoder().encode("hello") };
    }
  });

  controller.setEntry({ kind: "file", path: "/workspace/readme.md" });
  assert.equal(controller.getSnapshot().status, "loading");
  await flush();
  assert.deepEqual(controller.getSnapshot(), {
    content: "hello",
    entry: { kind: "file", path: "/workspace/readme.md" },
    previewSizeBytes: 5,
    status: "text"
  });

  controller.setEntry({ kind: "file", path: "/workspace/fail.md" });
  await flush();
  assert.deepEqual(controller.getSnapshot(), {
    entry: { kind: "file", path: "/workspace/fail.md" },
    error: failure,
    status: "error"
  });
});

test("preview controller fences late reads and aborts the replaced request", async () => {
  const deferred = createDeferredRead();
  const controller = createController({ read: deferred.read });

  controller.setEntry({ kind: "file", path: "/workspace/a.md" });
  controller.setEntry({ kind: "file", path: "/workspace/b.md" });
  assert.equal(deferred.reads.length, 2);
  assert.equal(deferred.reads[0]?.signal.aborted, true);

  deferred.reads[1]?.resolve({ bytes: new TextEncoder().encode("B") });
  await flush();
  const loadedB = controller.getSnapshot();
  assert.equal(loadedB.status === "text" ? loadedB.content : null, "B");

  deferred.reads[0]?.resolve({ bytes: new TextEncoder().encode("A") });
  await flush();
  const retainedB = controller.getSnapshot();
  assert.equal(retainedB.status === "text" ? retainedB.content : null, "B");
});

test("preview controller revokes media URLs on replacement and disposal", async () => {
  const objectUrls = createObjectUrls();
  const controller = createController({
    objectUrls: objectUrls.factory,
    read: async () => ({ bytes: new Uint8Array([1, 2, 3]) })
  });

  controller.setEntry({ kind: "file", path: "/workspace/a.png" });
  await flush();
  assert.deepEqual(objectUrls.created, ["blob:test-1"]);
  assert.equal(controller.getSnapshot().status, "image");

  controller.setEntry({ kind: "file", path: "/workspace/b.png" });
  assert.deepEqual(objectUrls.revoked, ["blob:test-1"]);
  await flush();
  controller.dispose();
  assert.deepEqual(objectUrls.revoked, ["blob:test-1", "blob:test-2"]);
});

test("preview controller reloads when metadata changes and on explicit reload", async () => {
  let reads = 0;
  const controller = createController({
    read: async () => {
      reads += 1;
      return { bytes: new TextEncoder().encode(String(reads)) };
    }
  });

  controller.setEntry({
    kind: "file",
    mtimeMs: 1,
    path: "/workspace/readme.md"
  });
  await flush();
  controller.setEntry({
    kind: "file",
    mtimeMs: 1,
    path: "/workspace/readme.md"
  });
  await flush();
  assert.equal(reads, 1);

  controller.setEntry({
    kind: "file",
    mtimeMs: 2,
    path: "/workspace/readme.md"
  });
  await flush();
  controller.reload();
  await flush();
  assert.equal(reads, 3);
});

test("preview controller reports an unavailable reader explicitly", () => {
  const controller = createController();
  controller.setEntry({ kind: "file", path: "/workspace/readme.md" });
  assert.deepEqual(controller.getSnapshot(), {
    entry: { kind: "file", path: "/workspace/readme.md" },
    reason: "reader_unavailable",
    status: "unsupported"
  });
});

test("preview controller skips reading when canReadEntry explicitly returns false for recognized text", async () => {
  let reads = 0;
  const controller = createWorkspaceFilePreviewController<TestEntry>({
    canReadEntry: () => false,
    read: async () => {
      reads += 1;
      return { bytes: new TextEncoder().encode("content") };
    },
    toPreviewEntry: (entry) => entry
  });

  // .md is a recognized text file, but canReadEntry=false should skip reading
  controller.setEntry({ kind: "file", path: "/workspace/readme.md" });
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.status, "unsupported");
  assert.equal(
    snapshot.status === "unsupported" ? snapshot.reason : undefined,
    "reader_unavailable"
  );
  assert.equal(reads, 0);

  // .json is also recognized text, same behavior
  controller.setEntry({ kind: "file", path: "/workspace/data.json" });
  assert.equal(controller.getSnapshot().status, "unsupported");
  assert.equal(reads, 0);

  controller.dispose();
});

test("preview controller resolves directories before consulting the source capability", () => {
  let capabilityChecks = 0;
  let reads = 0;
  const controller = createWorkspaceFilePreviewController<TestEntry>({
    canReadEntry: () => {
      capabilityChecks += 1;
      return false;
    },
    read: async () => {
      reads += 1;
      return { bytes: new Uint8Array() };
    },
    toPreviewEntry: (entry) => entry
  });

  controller.setEntry({ kind: "directory", path: "/workspace/src" });

  assert.equal(controller.getSnapshot().status, "directory");
  assert.equal(capabilityChecks, 0);
  assert.equal(reads, 0);
  controller.dispose();
});

test("preview controller attempts reading for unknown extension when canReadEntry returns true", async () => {
  let reads = 0;
  const controller = createWorkspaceFilePreviewController<TestEntry>({
    canReadEntry: () => true,
    read: async () => {
      reads += 1;
      // Source provides kind from server response
      return {
        bytes: new TextEncoder().encode("server content"),
        kind: "text"
      };
    },
    toPreviewEntry: (entry) => entry
  });

  // .xyz is not a recognized extension locally
  controller.setEntry({ kind: "file", path: "/workspace/file.xyz" });
  assert.equal(controller.getSnapshot().status, "loading");
  await flush();

  // Should have attempted to read because canReadEntry=true
  assert.equal(reads, 1);
  assert.equal(controller.getSnapshot().status, "text");

  controller.dispose();
});

test("preview controller reports an unavailable reader for an explicitly readable unknown file", () => {
  const entry: TestEntry = {
    kind: "file",
    path: "/workspace/file.xyz"
  };
  const controller = createWorkspaceFilePreviewController<TestEntry>({
    canReadEntry: () => true,
    toPreviewEntry: (value) => value
  });

  controller.setEntry(entry);

  assert.deepEqual(controller.getSnapshot(), {
    entry,
    reason: "reader_unavailable",
    status: "unsupported"
  });
  controller.dispose();
});

test("preview controller allows source-provided kind to override local classification", async () => {
  let reads = 0;
  const controller = createWorkspaceFilePreviewController<TestEntry>({
    canReadEntry: () => true,
    read: async () => {
      reads += 1;
      // Source says this unknown file is actually an image
      return {
        bytes: new Uint8Array([0, 1, 2, 3]),
        contentType: "image/png",
        kind: "image"
      };
    },
    toPreviewEntry: (entry) => entry
  });

  // .data is unrecognized, but source provides kind="image"
  controller.setEntry({ kind: "file", path: "/workspace/unknown.data" });
  await flush();

  assert.equal(reads, 1);
  assert.equal(controller.getSnapshot().status, "image");

  controller.dispose();
});
