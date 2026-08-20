import assert from "node:assert/strict";
import test from "node:test";

import type { ReferenceNode } from "../../../contracts/referenceSource.ts";
import {
  REFERENCE_SEARCH_RESULT_BLOCK_PAGE_CAPACITY,
  appendReferenceSearchResultPage,
  createReferenceSearchResultIndex,
  referenceSearchResultNodeAt
} from "./referenceSearchResultIndex.ts";

function file(index: number): ReferenceNode {
  return {
    ref: { sourceId: "workspace-file", nodeId: `file-${index}` },
    kind: "file",
    displayName: `file-${index}.md`
  };
}

test("deep cursor pagination keeps immutable bounded page blocks", () => {
  let index = createReferenceSearchResultIndex();
  const emptySnapshot = index;

  for (let page = 0; page < 5_000; page += 1) {
    index = appendReferenceSearchResultPage(index, [file(page)]);
  }

  assert.equal(index.entryCount, 5_000);
  assert.equal(index.pageCount, 5_000);
  assert.equal(referenceSearchResultNodeAt(index, 0)?.displayName, "file-0.md");
  assert.equal(
    referenceSearchResultNodeAt(index, 2_499)?.displayName,
    "file-2499.md"
  );
  assert.equal(
    referenceSearchResultNodeAt(index, 4_999)?.displayName,
    "file-4999.md"
  );
  assert.equal(emptySnapshot.entryCount, 0);
  assert.equal(emptySnapshot.pageCount, 0);
  const blocks = [
    ...index.sealedBlocks,
    ...(index.tailBlock ? [index.tailBlock] : [])
  ];
  assert.ok(
    blocks.every(
      (block) =>
        block.pages.length <= REFERENCE_SEARCH_RESULT_BLOCK_PAGE_CAPACITY
    )
  );
  assert.ok(
    blocks.length <=
      Math.ceil(5_000 / REFERENCE_SEARCH_RESULT_BLOCK_PAGE_CAPACITY)
  );
});

test("appending a page cannot mutate an older result snapshot", () => {
  const first = appendReferenceSearchResultPage(
    createReferenceSearchResultIndex(),
    [file(1)]
  );
  const saved = structuredClone(first);
  const second = appendReferenceSearchResultPage(first, [file(2)]);

  assert.deepEqual(first, saved);
  assert.equal(first.entryCount, 1);
  assert.equal(second.entryCount, 2);
  assert.equal(referenceSearchResultNodeAt(first, 1), undefined);
  assert.equal(
    referenceSearchResultNodeAt(second, 1)?.displayName,
    "file-2.md"
  );
});
