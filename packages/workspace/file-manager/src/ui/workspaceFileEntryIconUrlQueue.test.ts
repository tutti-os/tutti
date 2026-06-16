import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";
import { resolveWorkspaceFileEntryIconCacheKey } from "./workspaceFileEntryIconPolicy.ts";
import { createWorkspaceFileEntryIconUrlQueue } from "./workspaceFileEntryIconUrlQueue.ts";

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

test("icon url queue ignores ordinary files", async () => {
  let calls = 0;
  const entry = createEntry({
    name: "photo.png",
    path: "/workspace/photo.png"
  });
  const queue = createWorkspaceFileEntryIconUrlQueue({
    async resolveEntryIconUrl() {
      calls += 1;
      return "tutti-file-icon://icon/photo";
    }
  });

  queue.retainEntries([entry]);
  queue.enterViewport(entry);
  await settleQueue();

  assert.equal(calls, 0);
  assert.equal(queue.snapshot().size, 0);
});

test("icon url queue resolves image thumbnails when enabled", async () => {
  let calls = 0;
  const entry = createEntry({
    name: "photo.png",
    path: "/workspace/photo.png"
  });
  const cacheKey = resolveWorkspaceFileEntryIconCacheKey(entry);
  const queue = createWorkspaceFileEntryIconUrlQueue({
    includeImageThumbnails: true,
    async resolveEntryIconUrl() {
      calls += 1;
      return "tutti-file-icon://icon/photo";
    }
  });

  queue.retainEntries([entry]);
  queue.enterViewport(entry);
  await settleQueue();

  assert.equal(calls, 1);
  assert.equal(queue.snapshot().get(cacheKey), "tutti-file-icon://icon/photo");
});

test("icon url queue keeps resolved image thumbnails after viewport release", async () => {
  const entry = createEntry({
    name: "photo.png",
    path: "/workspace/photo.png"
  });
  const cacheKey = resolveWorkspaceFileEntryIconCacheKey(entry);
  const queue = createWorkspaceFileEntryIconUrlQueue({
    includeImageThumbnails: true,
    async resolveEntryIconUrl() {
      return "tutti-file-icon://icon/photo";
    }
  });

  queue.retainEntries([entry]);
  queue.enterViewport(entry);
  await settleQueue();

  queue.leaveViewport(entry);

  assert.equal(queue.snapshot().get(cacheKey), "tutti-file-icon://icon/photo");

  queue.retainEntries([]);

  assert.equal(queue.snapshot().has(cacheKey), false);
});

test("icon url queue can be reactivated after development effect cleanup", async () => {
  let calls = 0;
  const entry = createEntry({
    name: "photo.png",
    path: "/workspace/photo.png"
  });
  const cacheKey = resolveWorkspaceFileEntryIconCacheKey(entry);
  const queue = createWorkspaceFileEntryIconUrlQueue({
    includeImageThumbnails: true,
    async resolveEntryIconUrl() {
      calls += 1;
      return "tutti-file-icon://icon/photo";
    }
  });

  queue.retainEntries([entry]);
  queue.dispose();
  queue.activate();
  queue.retainEntries([entry]);
  queue.enterViewport(entry);
  await settleQueue();

  assert.equal(calls, 1);
  assert.equal(queue.snapshot().get(cacheKey), "tutti-file-icon://icon/photo");
});

test("icon url queue stores in-flight image thumbnails after viewport release", async () => {
  const entry = createEntry({
    name: "photo.png",
    path: "/workspace/photo.png"
  });
  const cacheKey = resolveWorkspaceFileEntryIconCacheKey(entry);
  const iconRead = createDeferred<string>();
  const queue = createWorkspaceFileEntryIconUrlQueue({
    includeImageThumbnails: true,
    resolveEntryIconUrl() {
      return iconRead.promise;
    }
  });

  queue.retainEntries([entry]);
  queue.enterViewport(entry);
  await settleQueue();
  queue.leaveViewport(entry);
  iconRead.resolve("tutti-file-icon://icon/photo");
  await settleQueue();

  assert.equal(queue.snapshot().get(cacheKey), "tutti-file-icon://icon/photo");
});

test("icon url queue ignores ordinary files named like application bundles", async () => {
  let calls = 0;
  const entry = createEntry({
    kind: "file",
    name: "Fake.app",
    path: "/workspace/Fake.app"
  });
  const queue = createWorkspaceFileEntryIconUrlQueue({
    async resolveEntryIconUrl() {
      calls += 1;
      return "tutti-file-icon://icon/fake";
    }
  });

  queue.retainEntries([entry]);
  queue.enterViewport(entry);
  await settleQueue();

  assert.equal(calls, 0);
  assert.equal(queue.snapshot().size, 0);
});

test("icon url queue dedupes default application icon requests by extension", async () => {
  let calls = 0;
  const first = createEntry({
    name: "Deck.pptx",
    path: "/workspace/Deck.pptx"
  });
  const second = createEntry({
    name: "Another.pptx",
    path: "/workspace/Another.pptx"
  });
  const cacheKey = resolveWorkspaceFileEntryIconCacheKey(first);
  const queue = createWorkspaceFileEntryIconUrlQueue({
    async resolveEntryIconUrl() {
      calls += 1;
      return "tutti-file-icon://icon/pptx";
    }
  });

  queue.retainEntries([first, second]);
  queue.enterViewport(first);
  queue.enterViewport(second);
  await settleQueue();

  assert.equal(resolveWorkspaceFileEntryIconCacheKey(second), cacheKey);
  assert.equal(calls, 1);
  assert.equal(queue.snapshot().get(cacheKey), "tutti-file-icon://icon/pptx");
});

test("icon url queue dedupes application icon requests", async () => {
  let calls = 0;
  const entry = createEntry({
    kind: "unknown",
    name: "Zoom.app",
    path: "/workspace/Zoom.app"
  });
  const cacheKey = resolveWorkspaceFileEntryIconCacheKey(entry);
  const queue = createWorkspaceFileEntryIconUrlQueue({
    async resolveEntryIconUrl() {
      calls += 1;
      return " tutti-file-icon://icon/zoom ";
    }
  });

  queue.retainEntries([entry]);
  queue.enterViewport(entry);
  queue.enterViewport(entry);
  await settleQueue();

  assert.equal(calls, 1);
  assert.equal(queue.snapshot().get(cacheKey), "tutti-file-icon://icon/zoom");
});

test("icon url queue caches failed application icon requests as null", async () => {
  let calls = 0;
  const entry = createEntry({
    kind: "unknown",
    name: "Broken.app",
    path: "/workspace/Broken.app"
  });
  const cacheKey = resolveWorkspaceFileEntryIconCacheKey(entry);
  const queue = createWorkspaceFileEntryIconUrlQueue({
    async resolveEntryIconUrl() {
      calls += 1;
      throw new Error("missing icon");
    }
  });

  queue.retainEntries([entry]);
  queue.enterViewport(entry);
  await settleQueue();
  queue.enterViewport(entry);
  await settleQueue();

  assert.equal(calls, 1);
  assert.equal(queue.snapshot().get(cacheKey), null);
});

test("icon url queue releases cached icons when entries leave the viewport", async () => {
  const entry = createEntry({
    name: "Deck.pptx",
    path: "/workspace/Deck.pptx"
  });
  const cacheKey = resolveWorkspaceFileEntryIconCacheKey(entry);
  const queue = createWorkspaceFileEntryIconUrlQueue({
    async resolveEntryIconUrl() {
      return "tutti-file-icon://icon/pptx";
    }
  });

  queue.retainEntries([entry]);
  queue.enterViewport(entry);
  await settleQueue();

  assert.equal(queue.snapshot().get(cacheKey), "tutti-file-icon://icon/pptx");

  queue.leaveViewport(entry);

  assert.equal(queue.snapshot().has(cacheKey), false);
});

test("icon url queue discards in-flight results after viewport release", async () => {
  const entry = createEntry({
    name: "Deck.pptx",
    path: "/workspace/Deck.pptx"
  });
  const cacheKey = resolveWorkspaceFileEntryIconCacheKey(entry);
  const iconRead = createDeferred<string>();
  const queue = createWorkspaceFileEntryIconUrlQueue({
    resolveEntryIconUrl() {
      return iconRead.promise;
    }
  });

  queue.retainEntries([entry]);
  queue.enterViewport(entry);
  await settleQueue();
  queue.leaveViewport(entry);
  iconRead.resolve("tutti-file-icon://icon/pptx");
  await settleQueue();

  assert.equal(queue.snapshot().has(cacheKey), false);
});

test("icon url queue removes queued entries after viewport release", async () => {
  const first = createEntry({
    name: "Deck.pptx",
    path: "/workspace/Deck.pptx"
  });
  const second = createEntry({
    name: "Design.psd",
    path: "/workspace/Design.psd"
  });
  const started: string[] = [];
  const firstIconRead = createDeferred<string>();
  const queue = createWorkspaceFileEntryIconUrlQueue({
    maxConcurrent: 1,
    resolveEntryIconUrl(entry) {
      started.push(entry.name);
      return entry === first
        ? firstIconRead.promise
        : Promise.resolve(`tutti-file-icon://icon/${entry.name}`);
    }
  });

  queue.retainEntries([first, second]);
  queue.enterViewport(first);
  queue.enterViewport(second);
  await settleQueue();
  queue.leaveViewport(second);
  firstIconRead.resolve("tutti-file-icon://icon/pptx");
  await settleQueue();

  assert.deepEqual(started, ["Deck.pptx"]);
});

test("icon url queue keeps shared file type icons while any matching entry is visible", async () => {
  const first = createEntry({
    name: "Deck.pptx",
    path: "/workspace/Deck.pptx"
  });
  const second = createEntry({
    name: "Another.pptx",
    path: "/workspace/Another.pptx"
  });
  const cacheKey = resolveWorkspaceFileEntryIconCacheKey(first);
  const queue = createWorkspaceFileEntryIconUrlQueue({
    async resolveEntryIconUrl() {
      return "tutti-file-icon://icon/pptx";
    }
  });

  queue.retainEntries([first, second]);
  queue.enterViewport(first);
  queue.enterViewport(second);
  await settleQueue();

  queue.leaveViewport(first);

  assert.equal(queue.snapshot().get(cacheKey), "tutti-file-icon://icon/pptx");

  queue.leaveViewport(second);

  assert.equal(queue.snapshot().has(cacheKey), false);
});

test("icon url queue retries failed icon requests after retained entries refresh", async () => {
  let calls = 0;
  const entry = createEntry({
    name: "Deck.pptx",
    path: "/workspace/Deck.pptx"
  });
  const cacheKey = resolveWorkspaceFileEntryIconCacheKey(entry);
  const queue = createWorkspaceFileEntryIconUrlQueue({
    async resolveEntryIconUrl() {
      calls += 1;
      if (calls === 1) {
        throw new Error("temporary icon failure");
      }
      return "tutti-file-icon://icon/pptx";
    }
  });

  queue.retainEntries([entry]);
  queue.enterViewport(entry);
  await settleQueue();
  queue.enterViewport(entry);
  await settleQueue();

  assert.equal(calls, 1);
  assert.equal(queue.snapshot().get(cacheKey), null);

  queue.retainEntries([entry]);
  assert.equal(queue.snapshot().has(cacheKey), false);

  queue.enterViewport(entry);
  await settleQueue();

  assert.equal(calls, 2);
  assert.equal(queue.snapshot().get(cacheKey), "tutti-file-icon://icon/pptx");
});

test("icon url queue limits concurrent requests", async () => {
  const activeResolves: (() => void)[] = [];
  const started: string[] = [];
  const entries = Array.from({ length: 5 }, (_, index) =>
    createEntry({
      kind: "unknown",
      name: `App ${index}.app`,
      path: `/workspace/App ${index}.app`
    })
  );
  const queue = createWorkspaceFileEntryIconUrlQueue({
    maxConcurrent: 3,
    resolveEntryIconUrl(entry) {
      started.push(entry.path);
      return new Promise((resolve) => {
        activeResolves.push(() => {
          resolve(`tutti-file-icon://icon/${entry.name}`);
        });
      });
    }
  });

  queue.retainEntries(entries);
  for (const entry of entries) {
    queue.enterViewport(entry);
  }
  await settleQueue();

  assert.equal(started.length, 3);
  activeResolves.shift()?.();
  await settleQueue();
  assert.equal(started.length, 4);

  while (activeResolves.length > 0) {
    activeResolves.shift()?.();
  }
  await settleQueue();
});

test("icon url queue preserves requests made before retained entries refresh", async () => {
  const oldEntry = createEntry({
    kind: "unknown",
    name: "Old.app",
    path: "/workspace/Old.app"
  });
  const nextEntry = createEntry({
    kind: "unknown",
    name: "Next.app",
    path: "/workspace/Next.app"
  });
  const nextCacheKey = resolveWorkspaceFileEntryIconCacheKey(nextEntry);
  let calls = 0;
  const iconRead = createDeferred<string>();
  const queue = createWorkspaceFileEntryIconUrlQueue({
    resolveEntryIconUrl() {
      calls += 1;
      return iconRead.promise;
    }
  });

  queue.retainEntries([oldEntry]);
  queue.enterViewport(nextEntry);
  await settleQueue();
  queue.retainEntries([nextEntry]);
  iconRead.resolve("tutti-file-icon://icon/next");
  await settleQueue();

  assert.equal(calls, 1);
  assert.equal(
    queue.snapshot().get(nextCacheKey),
    "tutti-file-icon://icon/next"
  );
});

test("icon url queue treats mtime changes as new cache keys", async () => {
  let calls = 0;
  const first = createEntry({
    kind: "unknown",
    mtimeMs: 1,
    name: "Demo.app",
    path: "/workspace/Demo.app"
  });
  const second = { ...first, mtimeMs: 2 };
  const queue = createWorkspaceFileEntryIconUrlQueue({
    async resolveEntryIconUrl() {
      calls += 1;
      return `tutti-file-icon://icon/demo-${calls}`;
    }
  });

  queue.retainEntries([first]);
  queue.enterViewport(first);
  await settleQueue();
  queue.retainEntries([second]);
  queue.enterViewport(second);
  await settleQueue();

  assert.equal(calls, 2);
  assert.equal(
    queue.snapshot().get(resolveWorkspaceFileEntryIconCacheKey(second)),
    "tutti-file-icon://icon/demo-2"
  );
});

test("icon url queue keeps file type cache keys stable across mtime changes", async () => {
  let calls = 0;
  const first = createEntry({
    mtimeMs: 1,
    name: "Deck.pptx",
    path: "/workspace/Deck.pptx"
  });
  const second = { ...first, mtimeMs: 2 };
  const queue = createWorkspaceFileEntryIconUrlQueue({
    async resolveEntryIconUrl() {
      calls += 1;
      return `tutti-file-icon://icon/pptx-${calls}`;
    }
  });

  queue.retainEntries([first]);
  queue.enterViewport(first);
  await settleQueue();
  queue.retainEntries([second]);
  queue.enterViewport(second);
  await settleQueue();

  assert.equal(calls, 1);
  assert.equal(
    queue.snapshot().get(resolveWorkspaceFileEntryIconCacheKey(second)),
    "tutti-file-icon://icon/pptx-1"
  );
});

async function settleQueue(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolveDeferred: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}
