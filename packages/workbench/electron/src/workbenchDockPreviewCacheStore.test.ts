import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWorkbenchDockPreviewCacheStore,
  type WorkbenchDockPreviewCacheKey
} from "./workbenchDockPreviewCacheStore.ts";

test("writes and reads a validated preview with hashed filenames", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = createWorkbenchDockPreviewCacheStore({ directory });
    const dataUrl = pngDataUrl("preview");

    assert.equal(await store.write({ dataUrl, key: cacheKey() }), true);
    assert.equal(await store.read(cacheKey()), dataUrl);

    const files = await fs.readdir(directory);
    assert.equal(files.length, 2);
    assert.equal(files.includes("index.json"), true);
    assert.match(
      files.find((file) => file !== "index.json") ?? "",
      /^[a-f0-9]{64}\.png$/u
    );
    assert.equal(
      files.some((file) => file.includes("workspace")),
      false
    );
    assert.equal(
      files.some((file) => file.includes(".tmp-")),
      false
    );
  });
});

test("rejects invalid keys, malformed data URLs, and oversized images", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = createWorkbenchDockPreviewCacheStore({
      directory,
      maxEntryBytes: 8
    });
    const invalidKey = { ...cacheKey(), workspaceId: "" };

    assert.equal(
      await store.write({ dataUrl: pngDataUrl("small"), key: invalidKey }),
      false
    );
    assert.equal(
      await store.write({
        dataUrl: "data:text/plain;base64,cHJldmlldw==",
        key: cacheKey()
      }),
      false
    );
    assert.equal(
      await store.write({
        dataUrl: "data:image/png;base64,not=canonical=",
        key: cacheKey()
      }),
      false
    );
    assert.equal(
      await store.write({
        dataUrl: pngDataUrl("larger than eight bytes"),
        key: cacheKey()
      }),
      false
    );
    assert.deepEqual(await fs.readdir(directory), []);
  });
});

test("includes revision in cache identity", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = createWorkbenchDockPreviewCacheStore({ directory });
    const firstKey = cacheKey({ revision: "one" });
    const secondKey = cacheKey({ revision: "two" });

    await store.write({ dataUrl: pngDataUrl("first"), key: firstKey });
    await store.write({ dataUrl: pngDataUrl("second"), key: secondKey });

    assert.equal(await store.read(firstKey), pngDataUrl("first"));
    assert.equal(await store.read(secondKey), pngDataUrl("second"));
    assert.equal(
      (await fs.readdir(directory)).filter((file) => file.endsWith(".png"))
        .length,
      2
    );
  });
});

test("prunes oldest entries by entry count", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = createWorkbenchDockPreviewCacheStore({
      directory,
      maxEntries: 2
    });
    const first = cacheKey({ nodeId: "first" });
    const second = cacheKey({ nodeId: "second" });
    const third = cacheKey({ nodeId: "third" });

    await Promise.all([
      store.write({ dataUrl: pngDataUrl("first"), key: first }),
      store.write({ dataUrl: pngDataUrl("second"), key: second }),
      store.write({ dataUrl: pngDataUrl("third"), key: third })
    ]);

    assert.equal(await store.read(first), null);
    assert.equal(await store.read(second), pngDataUrl("second"));
    assert.equal(await store.read(third), pngDataUrl("third"));
  });
});

test("prunes entries to the total byte limit", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = createWorkbenchDockPreviewCacheStore({
      directory,
      maxTotalBytes: 9
    });
    const first = cacheKey({ nodeId: "first" });
    const second = cacheKey({ nodeId: "second" });

    await store.write({ dataUrl: pngDataUrl("12345"), key: first });
    await store.write({ dataUrl: pngDataUrl("67890"), key: second });

    assert.equal(await store.read(first), null);
    assert.equal(await store.read(second), pngDataUrl("67890"));
  });
});

test("ignores corrupted index entries instead of reading outside the cache", async () => {
  await withTemporaryDirectory(async (directory) => {
    const outsidePath = path.join(directory, "..", "dock-preview-secret");
    await fs.writeFile(outsidePath, "secret");
    await fs.writeFile(
      path.join(directory, "index.json"),
      JSON.stringify({
        entries: {
          ["a".repeat(64)]: {
            byteLength: 6,
            file: "../dock-preview-secret",
            mimeType: "image/png",
            updatedAtUnixMs: Date.now()
          }
        },
        version: 1
      })
    );
    const store = createWorkbenchDockPreviewCacheStore({ directory });

    assert.equal(await store.read(cacheKey()), null);
    assert.equal(await fs.readFile(outsidePath, "utf8"), "secret");
    await fs.rm(outsidePath, { force: true });
  });
});

test("rejects invalid cache limits", () => {
  assert.throws(
    () =>
      createWorkbenchDockPreviewCacheStore({
        directory: "/tmp/dock-preview-test",
        maxEntries: 0
      }),
    /positive integers/u
  );
});

function cacheKey(
  overrides: Partial<WorkbenchDockPreviewCacheKey> = {}
): WorkbenchDockPreviewCacheKey {
  return {
    instanceId: "instance",
    instanceKey: "instance-key",
    nodeId: "node",
    revision: "revision",
    typeId: "type",
    workspaceId: "workspace",
    ...overrides
  };
}

function pngDataUrl(value: string): string {
  return `data:image/png;base64,${Buffer.from(value).toString("base64")}`;
}

async function withTemporaryDirectory(
  task: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "tutti-workbench-electron-test-")
  );
  try {
    await task(directory);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
}
