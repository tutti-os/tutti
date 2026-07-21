import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReferenceNode } from "../../../contracts/referenceSource.ts";
import {
  formatHierarchyTitle,
  formatReferenceNodePathText,
  formatReferencePreviewDateTime,
  resolveReferencePreviewTimestampMs,
  resolveReferencePreviewSizeBytes
} from "./referenceSourcePickerPresentation.ts";

function folder(nodeId: string, displayName: string): ReferenceNode {
  return {
    displayName,
    kind: "folder",
    ref: { sourceId: "workspace-file", nodeId }
  };
}

test("formatHierarchyTitle exposes the complete hierarchy path", () => {
  const title = formatHierarchyTitle([
    folder("Documents", "文稿"),
    folder("Documents/tutti", "tutti"),
    folder("Documents/tutti/tutti_research", "tutti_research"),
    folder("Documents/tutti/tutti_research/user-interviews", "用户访谈记录文档")
  ]);

  assert.equal(title, "文稿 / tutti / tutti_research / 用户访谈记录文档");
});

test("formatHierarchyTitle omits empty hierarchy paths", () => {
  assert.equal(formatHierarchyTitle([]), null);
});

test("formatReferenceNodePathText renders navigable groups as readable hierarchy labels", () => {
  const topic = folder("g:topic-id", "213");
  const group = folder("g:group-id", "2323");

  const pathText = formatReferenceNodePathText(group, [topic]);

  assert.equal(pathText, "213 / 2323");
  assert.doesNotMatch(pathText, /^g:/);
});

test("formatReferenceNodePathText does not duplicate the focused group when hierarchy already includes it", () => {
  const topic = folder("g:topic-id", "213");
  const group = folder("g:group-id", "2323");

  assert.equal(
    formatReferenceNodePathText(group, [topic, group]),
    "213 / 2323"
  );
});

test("formatReferenceNodePathText never exposes an opaque node id", () => {
  const node = {
    displayName: "111.md",
    kind: "file",
    ref: {
      sourceId: "workspace-file",
      nodeId: "opaque-workspace-reference-id"
    }
  } satisfies ReferenceNode;

  assert.equal(formatReferenceNodePathText(node), "111.md");
});

test("formatReferencePreviewDateTime formats timestamps in the requested user time zone", () => {
  const timestamp = Date.UTC(2026, 5, 12, 3, 24);

  assert.equal(
    formatReferencePreviewDateTime(timestamp, {
      locale: "en",
      timeZone: "UTC"
    }),
    "2026-06-12 03:24"
  );
  assert.equal(
    formatReferencePreviewDateTime(timestamp, {
      locale: "en",
      timeZone: "Asia/Shanghai"
    }),
    "2026-06-12 11:24"
  );
});

test("resolveReferencePreviewTimestampMs prefers creation time over modified time", () => {
  const node = {
    createdTimeMs: 1_800_000_000_000,
    displayName: "prd.md",
    kind: "file",
    mtimeMs: 1_800_000_001_000,
    ref: { sourceId: "workspace-file", nodeId: "f:prd.md" }
  } satisfies ReferenceNode;

  assert.equal(resolveReferencePreviewTimestampMs(node), 1_800_000_000_000);
});

test("resolveReferencePreviewTimestampMs falls back to modified time", () => {
  const node = {
    displayName: "prd.md",
    kind: "file",
    mtimeMs: 1_800_000_001_000,
    ref: { sourceId: "workspace-file", nodeId: "f:prd.md" }
  } satisfies ReferenceNode;

  assert.equal(resolveReferencePreviewTimestampMs(node), 1_800_000_001_000);
});

test("resolveReferencePreviewSizeBytes prefers loaded preview bytes over zero metadata", () => {
  const node = {
    displayName: "result.css",
    kind: "file",
    ref: { sourceId: "issue-file", nodeId: "f:result.css" },
    sizeBytes: 0
  } satisfies ReferenceNode;

  assert.equal(
    resolveReferencePreviewSizeBytes(node, {
      node,
      previewSizeBytes: 42
    }),
    42
  );
});
