import assert from "node:assert/strict";
import test from "node:test";
import { createRichTextAtRegistry } from "../plugins/atRegistry.ts";
import {
  createRichTextAtProvider,
  createRichTextTextInsertResult
} from "../plugins/at.ts";
import type { RichTextAtProvider } from "../types/at.ts";
import {
  findRichTextAtQuery,
  queryRichTextAtMatches
} from "./richTextAtQuery.ts";

test("findRichTextAtQuery supports @ after punctuation boundaries", () => {
  assert.deepEqual(findRichTextAtQuery("hello, @rea", 11), {
    from: 7,
    to: 11,
    keyword: "rea"
  });
  assert.deepEqual(findRichTextAtQuery("see(@rea", 8), {
    from: 4,
    to: 8,
    keyword: "rea"
  });
});

test("findRichTextAtQuery keeps slash and dot inside the query", () => {
  assert.deepEqual(findRichTextAtQuery("@src/index.ts", 13), {
    from: 0,
    to: 13,
    keyword: "src/index.ts"
  });
});

test("findRichTextAtQuery ignores @ inside email-like tokens", () => {
  assert.equal(findRichTextAtQuery("alice@example", 13), null);
});

test("queryRichTextAtMatches returns empty results when a provider throws", async () => {
  const registry = createRichTextAtRegistry([
    createRichTextAtProvider({
      id: "broken",
      async query() {
        throw new Error("search failed");
      },
      getItemKey: () => "broken",
      getItemLabel: () => "broken",
      toInsertResult: () => createRichTextTextInsertResult("broken")
    })
  ]);

  const matches = await queryRichTextAtMatches(registry, {
    context: {},
    keyword: "rea",
    maxResults: 5
  });

  assert.deepEqual(matches, []);
});

test("queryRichTextAtMatches preserves max results per provider", async () => {
  const registry = createRichTextAtRegistry([
    createTestIdProvider("files", ["a", "b"]),
    createTestIdProvider("sessions", ["session"])
  ]);

  const matches = await queryRichTextAtMatches(registry, {
    context: {},
    keyword: "",
    maxResults: 1
  });

  assert.deepEqual(
    matches.map((match) => `${match.providerId}:${match.key}`),
    ["files:a", "sessions:session"]
  );
});

test("queryRichTextAtMatches returns empty results after abort", async () => {
  const registry = createRichTextAtRegistry([
    createRichTextAtProvider({
      id: "slow",
      async query() {
        await Promise.resolve();
        return [{ id: "readme" }];
      },
      getItemKey: (item) => item.id,
      getItemLabel: (item) => item.id,
      toInsertResult: (item) => createRichTextTextInsertResult(item.id)
    }) as RichTextAtProvider<unknown>
  ]);
  const abortController = new AbortController();

  const matchesPromise = queryRichTextAtMatches(registry, {
    abortSignal: abortController.signal,
    context: {},
    keyword: "rea",
    maxResults: 5
  });
  abortController.abort();

  const matches = await matchesPromise;
  assert.deepEqual(matches, []);
});

function createTestIdProvider(
  providerId: string,
  itemIds: readonly string[]
): RichTextAtProvider {
  return {
    id: providerId,
    query: () => itemIds.map((id) => ({ id })),
    getItemKey: (item) => richTextAtQueryTestItemId(item),
    getItemLabel: (item) => richTextAtQueryTestItemId(item),
    toInsertResult: (item) =>
      createRichTextTextInsertResult(richTextAtQueryTestItemId(item))
  };
}

function richTextAtQueryTestItemId(item: unknown): string {
  if (
    typeof item === "object" &&
    item !== null &&
    "id" in item &&
    typeof (item as { id?: unknown }).id === "string"
  ) {
    return (item as { id: string }).id;
  }
  throw new TypeError("Expected a rich text @ query test item with an id");
}
