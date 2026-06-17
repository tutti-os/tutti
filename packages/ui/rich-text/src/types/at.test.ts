import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  RichTextAtProvider,
  RichTextAtQueryInput,
  RichTextAtReferenceItemsResult
} from "./at.ts";

test("RichTextAtProvider supports thumbnail + reference-items + cursor", async () => {
  const refs: RichTextAtReferenceItemsResult = {
    items: [],
    nextCursor: null
  };
  const provider: RichTextAtProvider<{ id: string }> = {
    id: "x",
    query: () => [],
    getItemKey: (item) => item.id,
    getItemLabel: (item) => item.id,
    getItemThumbnailUrl: () => null,
    getItemReferenceItems: async () => refs,
    toInsertResult: () => ({ kind: "text", text: "" })
  };
  const input: RichTextAtQueryInput = {
    keyword: "",
    cursor: "c1",
    context: {}
  };
  assert.equal(provider.id, "x");
  assert.equal(input.cursor, "c1");
  assert.equal(
    await provider.getItemReferenceItems?.({ id: "a" }, input),
    refs
  );
});
