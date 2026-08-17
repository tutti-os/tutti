import type { ReferenceNode } from "../../../contracts/referenceSource.ts";

/**
 * A block is deliberately small enough that appending one cursor page only
 * copies a bounded tail. Sealed blocks are immutable and reused by every later
 * snapshot, so historical picker snapshots cannot be changed by future pages.
 */
export const REFERENCE_SEARCH_RESULT_BLOCK_PAGE_CAPACITY = 128;

export interface ReferenceSearchResultBlock {
  readonly entryCount: number;
  readonly pages: readonly (readonly ReferenceNode[])[];
  /** Page starts relative to this block. */
  readonly pageStarts: readonly number[];
  /** First result index represented by this block. */
  readonly startIndex: number;
}

export interface ReferenceSearchResultIndex {
  readonly entryCount: number;
  readonly pageCount: number;
  readonly sealedBlocks: readonly ReferenceSearchResultBlock[];
  readonly tailBlock: ReferenceSearchResultBlock | null;
}

const EMPTY_REFERENCE_SEARCH_RESULT_INDEX: ReferenceSearchResultIndex =
  Object.freeze({
    entryCount: 0,
    pageCount: 0,
    sealedBlocks: Object.freeze([]),
    tailBlock: null
  });

export function createReferenceSearchResultIndex(
  entries: readonly ReferenceNode[] = []
): ReferenceSearchResultIndex {
  return entries.length === 0
    ? EMPTY_REFERENCE_SEARCH_RESULT_INDEX
    : appendReferenceSearchResultPage(
        EMPTY_REFERENCE_SEARCH_RESULT_INDEX,
        entries
      );
}

export function appendReferenceSearchResultPage(
  current: ReferenceSearchResultIndex,
  entries: readonly ReferenceNode[]
): ReferenceSearchResultIndex {
  if (entries.length === 0) {
    return current;
  }

  const page = Object.freeze([...entries]);
  const tail = current.tailBlock;
  if (tail && tail.pages.length < REFERENCE_SEARCH_RESULT_BLOCK_PAGE_CAPACITY) {
    const nextTail = createBlock(
      tail.startIndex,
      [...tail.pages, page],
      [...tail.pageStarts, tail.entryCount],
      tail.entryCount + page.length
    );
    return freezeIndex({
      entryCount: current.entryCount + page.length,
      pageCount: current.pageCount + 1,
      sealedBlocks: current.sealedBlocks,
      tailBlock: nextTail
    });
  }

  const sealedBlocks = tail
    ? Object.freeze([...current.sealedBlocks, tail])
    : current.sealedBlocks;
  return freezeIndex({
    entryCount: current.entryCount + page.length,
    pageCount: current.pageCount + 1,
    sealedBlocks,
    tailBlock: createBlock(current.entryCount, [page], [0], page.length)
  });
}

export function referenceSearchResultNodeAt(
  index: ReferenceSearchResultIndex,
  resultIndex: number
): ReferenceNode | undefined {
  if (
    !Number.isInteger(resultIndex) ||
    resultIndex < 0 ||
    resultIndex >= index.entryCount
  ) {
    return undefined;
  }

  const sealed = findBlock(index.sealedBlocks, resultIndex);
  if (sealed) {
    return nodeAtInBlock(sealed, resultIndex);
  }
  return index.tailBlock
    ? nodeAtInBlock(index.tailBlock, resultIndex)
    : undefined;
}

export function referenceSearchResultNodes(
  index: ReferenceSearchResultIndex
): ReferenceNode[] {
  const nodes: ReferenceNode[] = [];
  for (const block of index.sealedBlocks) {
    for (const page of block.pages) {
      nodes.push(...page);
    }
  }
  if (index.tailBlock) {
    for (const page of index.tailBlock.pages) {
      nodes.push(...page);
    }
  }
  return nodes;
}

function createBlock(
  startIndex: number,
  pages: readonly (readonly ReferenceNode[])[],
  pageStarts: readonly number[],
  entryCount: number
): ReferenceSearchResultBlock {
  return Object.freeze({
    entryCount,
    pages: Object.freeze([...pages]),
    pageStarts: Object.freeze([...pageStarts]),
    startIndex
  });
}

function freezeIndex(
  index: ReferenceSearchResultIndex
): ReferenceSearchResultIndex {
  return Object.freeze(index);
}

function findBlock(
  blocks: readonly ReferenceSearchResultBlock[],
  resultIndex: number
): ReferenceSearchResultBlock | null {
  let low = 0;
  let high = blocks.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const block = blocks[middle];
    if (!block) {
      return null;
    }
    if (resultIndex < block.startIndex) {
      high = middle - 1;
      continue;
    }
    if (resultIndex >= block.startIndex + block.entryCount) {
      low = middle + 1;
      continue;
    }
    return block;
  }
  return null;
}

function nodeAtInBlock(
  block: ReferenceSearchResultBlock,
  resultIndex: number
): ReferenceNode | undefined {
  const relativeIndex = resultIndex - block.startIndex;
  if (relativeIndex < 0 || relativeIndex >= block.entryCount) {
    return undefined;
  }

  let low = 0;
  let high = block.pageStarts.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const pageStart = block.pageStarts[middle] ?? 0;
    const nextPageStart = block.pageStarts[middle + 1] ?? block.entryCount;
    if (relativeIndex < pageStart) {
      high = middle - 1;
      continue;
    }
    if (relativeIndex >= nextPageStart) {
      low = middle + 1;
      continue;
    }
    return block.pages[middle]?.[relativeIndex - pageStart];
  }
  return undefined;
}
