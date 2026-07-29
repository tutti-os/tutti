import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateWorkbenchGenieTextureBytes,
  pruneRemovedWorkbenchGenieTextureCacheEntries,
  readWorkbenchGenieTextureCacheEntry,
  writeWorkbenchGenieTextureCacheEntry
} from "./genieTextureCache.ts";

const limits = {
  maxBytes: 400,
  maxEntries: 2
};

test("bounds genie textures by entry count and keeps recently read entries", () => {
  const cache = new Map<string, ReturnType<typeof texture>>();
  writeWorkbenchGenieTextureCacheEntry(cache, "a", texture(5, 5), limits);
  writeWorkbenchGenieTextureCacheEntry(cache, "b", texture(5, 5), limits);

  assert.ok(readWorkbenchGenieTextureCacheEntry(cache, "a"));
  writeWorkbenchGenieTextureCacheEntry(cache, "c", texture(5, 5), limits);

  assert.deepEqual([...cache.keys()], ["a", "c"]);
});

test("bounds genie textures by estimated RGBA bytes", () => {
  const cache = new Map<string, ReturnType<typeof texture>>();
  writeWorkbenchGenieTextureCacheEntry(cache, "a", texture(5, 10), limits);
  writeWorkbenchGenieTextureCacheEntry(cache, "b", texture(5, 10), limits);
  writeWorkbenchGenieTextureCacheEntry(cache, "c", texture(5, 10), limits);

  assert.deepEqual([...cache.keys()], ["b", "c"]);
  assert.equal(estimateWorkbenchGenieTextureBytes(texture(5, 10)), 200);
});

test("does not retain a single texture larger than the byte limit", () => {
  const cache = new Map<string, ReturnType<typeof texture>>();
  writeWorkbenchGenieTextureCacheEntry(cache, "large", texture(11, 10), limits);

  assert.equal(cache.size, 0);
});

test("keeps restored node textures and removes textures for deleted nodes", () => {
  const cache = new Map([
    ["restored", texture(5, 5)],
    ["deleted", texture(5, 5)]
  ]);

  pruneRemovedWorkbenchGenieTextureCacheEntries(cache, new Set(["restored"]));

  assert.deepEqual([...cache.keys()], ["restored"]);
});

function texture(height: number, width: number) {
  return { canvas: { height, width } };
}
