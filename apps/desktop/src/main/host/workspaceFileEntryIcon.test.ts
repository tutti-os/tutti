import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  resolveWorkspaceFileEntryIconUrl,
  type WorkspaceFileEntryIconInput
} from "./workspaceFileEntryIcon.ts";
import type {
  WorkspaceFileIconCacheKey,
  WorkspaceFileIconCacheStore
} from "./workspaceFileIconCacheStore.ts";

test("resolveWorkspaceFileEntryIconUrl returns null for unsupported regular files", async () => {
  const cacheStore = createCacheStoreStub();

  assert.equal(
    await resolveWorkspaceFileEntryIconUrl(
      "/workspace/clip.mp4",
      createInput({
        kind: "file",
        name: "clip.mp4",
        path: "/workspace/clip.mp4"
      }),
      cacheStore
    ),
    null
  );
  assert.equal(
    await resolveWorkspaceFileEntryIconUrl(
      "/workspace/Fake.app",
      createInput({
        kind: "file",
        name: "Fake.app",
        path: "/workspace/Fake.app"
      }),
      cacheStore
    ),
    null
  );
  assert.equal(cacheStore.reads.length, 0);
  assert.equal(cacheStore.writes.length, 0);
});

test("resolveWorkspaceFileEntryIconUrl writes image thumbnail bytes to cache", async () => {
  const cacheStore = createCacheStoreStub();
  const thumbnailBytes = Buffer.from([9, 8, 7, 6]);
  let thumbnailReads = 0;

  const iconUrl = await resolveWorkspaceFileEntryIconUrl(
    "/workspace/photo.png",
    createInput({
      kind: "file",
      mtimeMs: 42,
      name: "photo.png",
      path: "/workspace/photo.png"
    }),
    cacheStore,
    {
      readImageThumbnailPngBytes: async (targetPath, maxEdgePx) => {
        thumbnailReads += 1;
        assert.equal(targetPath, "/workspace/photo.png");
        assert.equal(maxEdgePx, 160);
        return thumbnailBytes;
      },
      stat: async () => fileStats({ size: 1024 })
    }
  );

  assert.equal(iconUrl, "tutti-file-icon://icon/test-id");
  assert.equal(thumbnailReads, 1);
  assert.equal(cacheStore.reads.length, 1);
  assert.equal(cacheStore.writes.length, 1);
  assert.deepEqual(Buffer.from(cacheStore.writes[0]!.bytes), thumbnailBytes);
  assert.deepEqual(cacheStore.writes[0]!.key, {
    assetKind: "image-thumbnail",
    mtimeMs: 42,
    path: "/workspace/photo.png",
    sizePx: 160,
    workspaceID: "workspace-a"
  });
});

test("resolveWorkspaceFileEntryIconUrl returns cached image thumbnails before reading files", async () => {
  const cacheStore = createCacheStoreStub({
    cachedUrl: "tutti-file-icon://icon/cached-photo"
  });
  let statReads = 0;
  let thumbnailReads = 0;

  const iconUrl = await resolveWorkspaceFileEntryIconUrl(
    "/workspace/photo.png",
    createInput({
      kind: "file",
      name: "photo.png",
      path: "/workspace/photo.png"
    }),
    cacheStore,
    {
      readImageThumbnailPngBytes: async () => {
        thumbnailReads += 1;
        return Buffer.from([1]);
      },
      stat: async () => {
        statReads += 1;
        return fileStats({ size: 1024 });
      }
    }
  );

  assert.equal(iconUrl, "tutti-file-icon://icon/cached-photo");
  assert.equal(statReads, 0);
  assert.equal(thumbnailReads, 0);
  assert.equal(cacheStore.reads.length, 1);
  assert.equal(cacheStore.writes.length, 0);
});

test("resolveWorkspaceFileEntryIconUrl falls back to file URLs when thumbnail generation fails", async () => {
  const cacheStore = createCacheStoreStub();

  const iconUrl = await resolveWorkspaceFileEntryIconUrl(
    "/workspace/photo.png",
    createInput({
      kind: "file",
      name: "photo.png",
      path: "/workspace/photo.png"
    }),
    cacheStore,
    {
      readImageThumbnailPngBytes: async () => null,
      stat: async () => fileStats({ size: 1024 })
    }
  );

  assert.equal(iconUrl, pathToFileURL("/workspace/photo.png").href);
  assert.equal(cacheStore.reads.length, 1);
  assert.equal(cacheStore.writes.length, 0);
});

test("resolveWorkspaceFileEntryIconUrl falls back to file URLs when thumbnail cache write is rejected", async () => {
  const cacheStore = createCacheStoreStub({ writeUrl: null });

  const iconUrl = await resolveWorkspaceFileEntryIconUrl(
    "/workspace/photo.png",
    createInput({
      kind: "file",
      name: "photo.png",
      path: "/workspace/photo.png"
    }),
    cacheStore,
    {
      readImageThumbnailPngBytes: async () => Buffer.from([1, 2, 3]),
      stat: async () => fileStats({ size: 1024 })
    }
  );

  assert.equal(iconUrl, pathToFileURL("/workspace/photo.png").href);
  assert.equal(cacheStore.reads.length, 1);
  assert.equal(cacheStore.writes.length, 1);
});

test("resolveWorkspaceFileEntryIconUrl skips oversized image thumbnails", async () => {
  const cacheStore = createCacheStoreStub();
  let thumbnailReads = 0;

  const iconUrl = await resolveWorkspaceFileEntryIconUrl(
    "/workspace/large.png",
    createInput({
      kind: "file",
      name: "large.png",
      path: "/workspace/large.png"
    }),
    cacheStore,
    {
      readImageThumbnailPngBytes: async () => {
        thumbnailReads += 1;
        return Buffer.from([1]);
      },
      stat: async () => fileStats({ size: 21 * 1024 * 1024 })
    }
  );

  assert.equal(iconUrl, null);
  assert.equal(thumbnailReads, 0);
  assert.equal(cacheStore.reads.length, 1);
  assert.equal(cacheStore.writes.length, 0);
});

test("resolveWorkspaceFileEntryIconUrl returns null for regular directories", async () => {
  const cacheStore = createCacheStoreStub();

  assert.equal(
    await resolveWorkspaceFileEntryIconUrl(
      "/workspace/folder",
      createInput({
        kind: "directory",
        name: "folder",
        path: "/workspace/folder"
      }),
      cacheStore
    ),
    null
  );
  assert.equal(cacheStore.writes.length, 0);
});

test("resolveWorkspaceFileEntryIconUrl writes application icon bytes to cache", async () => {
  const cacheStore = createCacheStoreStub();
  const iconBytes = Buffer.from([1, 2, 3, 4]);

  const iconUrl = await resolveWorkspaceFileEntryIconUrl(
    "/Applications/Safari.app",
    createInput({
      kind: "unknown",
      mtimeMs: 42,
      name: "Safari.app",
      path: "/workspace/Safari.app"
    }),
    cacheStore,
    {
      readNativeFileIconPngBytes: async () => iconBytes
    }
  );

  assert.equal(iconUrl, "tutti-file-icon://icon/test-id");
  assert.equal(cacheStore.reads.length, 1);
  assert.equal(cacheStore.writes.length, 1);
  assert.deepEqual(Buffer.from(cacheStore.writes[0]!.bytes), iconBytes);
  assert.deepEqual(cacheStore.writes[0]!.key, {
    assetKind: "application-icon",
    mtimeMs: 42,
    path: "/workspace/Safari.app",
    workspaceID: "workspace-a"
  });
});

test("resolveWorkspaceFileEntryIconUrl converts fallback application data urls to cache bytes", async () => {
  const cacheStore = createCacheStoreStub();

  const iconUrl = await resolveWorkspaceFileEntryIconUrl(
    "/Applications/Demo.app",
    createInput({
      kind: "unknown",
      name: "Demo.app",
      path: "/workspace/Demo.app"
    }),
    cacheStore,
    {
      readApplicationIconDataUrl: async () => "data:image/png;base64,AQIDBA==",
      readNativeFileIconPngBytes: async () => null
    }
  );

  assert.equal(iconUrl, "tutti-file-icon://icon/test-id");
  assert.deepEqual(
    Buffer.from(cacheStore.writes[0]!.bytes),
    Buffer.from([1, 2, 3, 4])
  );
});

test("resolveWorkspaceFileEntryIconUrl writes default application icon bytes for selected file types", async () => {
  const cacheStore = createCacheStoreStub();

  const iconUrl = await resolveWorkspaceFileEntryIconUrl(
    "/workspace/brief.docx",
    createInput({
      kind: "file",
      name: "brief.docx",
      path: "/workspace/brief.docx"
    }),
    cacheStore,
    {
      readApplicationIconDataUrl: async () => "data:image/png;base64,AQIDBA==",
      resolveDefaultApplicationForFile: async () => ({
        applicationPath: "/Applications/Preview.app",
        name: "Preview"
      })
    }
  );

  assert.equal(iconUrl, "tutti-file-icon://icon/test-id");
  assert.equal(cacheStore.reads.length, 1);
  assert.equal(cacheStore.writes.length, 1);
  assert.deepEqual(
    Buffer.from(cacheStore.writes[0]!.bytes),
    Buffer.from([1, 2, 3, 4])
  );
  assert.deepEqual(cacheStore.writes[0]!.key, {
    applicationPath: "/Applications/Preview.app",
    assetKind: "file-type-default-application-icon",
    fileExtension: "docx",
    platform: "darwin"
  });
});

test("resolveWorkspaceFileEntryIconUrl returns cached application icon urls before generating", async () => {
  const cacheStore = createCacheStoreStub({
    cachedUrl: "tutti-file-icon://icon/cached-id"
  });
  let nativeIconReads = 0;
  let fallbackIconReads = 0;

  const iconUrl = await resolveWorkspaceFileEntryIconUrl(
    "/Applications/Cached.app",
    createInput({
      kind: "unknown",
      name: "Cached.app",
      path: "/workspace/Cached.app"
    }),
    cacheStore,
    {
      readApplicationIconDataUrl: async () => {
        fallbackIconReads += 1;
        return "data:image/png;base64,AQIDBA==";
      },
      readNativeFileIconPngBytes: async () => {
        nativeIconReads += 1;
        return Buffer.from([1, 2, 3, 4]);
      }
    }
  );

  assert.equal(iconUrl, "tutti-file-icon://icon/cached-id");
  assert.equal(nativeIconReads, 0);
  assert.equal(fallbackIconReads, 0);
  assert.equal(cacheStore.reads.length, 1);
  assert.equal(cacheStore.writes.length, 0);
});

test("resolveWorkspaceFileEntryIconUrl returns cached default application icon urls before reading icon data", async () => {
  const cacheStore = createCacheStoreStub({
    cachedUrl: "tutti-file-icon://icon/cached-pdf"
  });
  let iconDataReads = 0;

  const iconUrl = await resolveWorkspaceFileEntryIconUrl(
    "/workspace/brief.docx",
    createInput({
      kind: "file",
      name: "brief.docx",
      path: "/workspace/brief.docx"
    }),
    cacheStore,
    {
      readApplicationIconDataUrl: async () => {
        iconDataReads += 1;
        return "data:image/png;base64,AQIDBA==";
      },
      resolveDefaultApplicationForFile: async () => ({
        applicationPath: "/Applications/Preview.app",
        name: "Preview"
      })
    }
  );

  assert.equal(iconUrl, "tutti-file-icon://icon/cached-pdf");
  assert.equal(iconDataReads, 0);
  assert.equal(cacheStore.reads.length, 1);
  assert.equal(cacheStore.writes.length, 0);
});

function createInput(
  overrides: Partial<WorkspaceFileEntryIconInput> = {}
): WorkspaceFileEntryIconInput {
  return {
    kind: "file",
    mtimeMs: 1_700_000_000_000,
    name: "example.txt",
    path: "/workspace/example.txt",
    workspaceID: "workspace-a",
    ...overrides
  };
}

function createCacheStoreStub(
  options: { cachedUrl?: string | null; writeUrl?: string | null } = {}
): WorkspaceFileIconCacheStore & {
  reads: WorkspaceFileIconCacheKey[];
  writes: {
    bytes: Uint8Array;
    key: WorkspaceFileIconCacheKey;
    mimeType: "image/png";
  }[];
} {
  const writes: {
    bytes: Uint8Array;
    key: WorkspaceFileIconCacheKey;
    mimeType: "image/png";
  }[] = [];
  const reads: WorkspaceFileIconCacheKey[] = [];
  return {
    reads,
    writes,
    async readUrl(key) {
      reads.push(key);
      return options.cachedUrl ?? null;
    },
    async resolveProtocolUrl() {
      return null;
    },
    async write(input) {
      writes.push(input);
      return options.writeUrl === undefined
        ? "tutti-file-icon://icon/test-id"
        : options.writeUrl;
    }
  };
}

function fileStats({ size }: { size: number }): {
  isFile(): boolean;
  size: number;
} {
  return {
    isFile: () => true,
    size
  };
}
