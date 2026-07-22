import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReferenceNode } from "../../../contracts/referenceSource.ts";
import {
  SOURCE_ROOT_NODE_ID,
  type ReferenceSourceAggregator
} from "../../../core/referenceSourceAggregator.ts";
import { nodeRefKey } from "../../../core/referenceSourceUtils.ts";
import { ROOT_CHILDREN_KEY } from "./referenceSourcePickerController.ts";
import { buildReferenceSourcePickerFilteredTree } from "./referenceSourcePickerFilterTree.ts";

test("filter tree keeps only folders whose descendants contain a matching file", async () => {
  const photos = folder("/workspace/photos", "photos");
  const documents = folder("/workspace/documents", "documents");
  const nested = folder("/workspace/photos/nested", "nested");
  const entriesByNodeId: Record<string, ReferenceNode[]> = {
    [SOURCE_ROOT_NODE_ID]: [photos, documents],
    [photos.ref.nodeId]: [
      file("/workspace/photos/cover.png", "cover.png"),
      file("/workspace/photos/readme.md", "readme.md"),
      nested
    ],
    [nested.ref.nodeId]: [
      file("/workspace/photos/nested/banner.jpg", "banner.jpg")
    ],
    [documents.ref.nodeId]: [file("/workspace/documents/notes.md", "notes.md")]
  };
  const aggregator = {
    async listChildren(_scope, node) {
      return {
        entries: entriesByNodeId[node.nodeId] ?? [],
        nextCursor: null
      };
    }
  } as ReferenceSourceAggregator;

  const tree = await buildReferenceSourcePickerFilteredTree({
    aggregator,
    filters: ["image"],
    scope: { workspaceId: "workspace-1" },
    signal: new AbortController().signal,
    sourceId: "workspace-file"
  });

  assert.deepEqual(
    tree.childrenByKey[ROOT_CHILDREN_KEY]?.entries.map(
      (entry) => entry.displayName
    ),
    ["photos"]
  );
  assert.deepEqual(
    tree.childrenByKey[nodeRefKey(photos.ref)]?.entries.map(
      (entry) => entry.displayName
    ),
    ["cover.png", "nested"]
  );
  assert.deepEqual(
    tree.childrenByKey[nodeRefKey(nested.ref)]?.entries.map(
      (entry) => entry.displayName
    ),
    ["banner.jpg"]
  );
  assert.deepEqual(tree.childrenByKey[nodeRefKey(documents.ref)]?.entries, []);
});

test("filter tree isolates an unreadable descendant folder", async () => {
  const photos = folder("/Users/me/Pictures", "Pictures");
  const library = folder("/Users/me/Library", "Library");
  const protectedFolder = folder(
    "/Users/me/Library/Application Support/CloudDocs",
    "CloudDocs"
  );
  const entriesByNodeId: Record<string, ReferenceNode[]> = {
    [SOURCE_ROOT_NODE_ID]: [photos, library],
    [photos.ref.nodeId]: [file("/Users/me/Pictures/cover.png", "cover.png")],
    [library.ref.nodeId]: [protectedFolder]
  };
  const aggregator = {
    async listChildren(_scope, node) {
      if (node.nodeId === protectedFolder.ref.nodeId) {
        throw new Error("EACCES: operation not permitted");
      }
      return {
        entries: entriesByNodeId[node.nodeId] ?? [],
        nextCursor: null
      };
    }
  } as ReferenceSourceAggregator;

  const tree = await buildReferenceSourcePickerFilteredTree({
    aggregator,
    filters: ["image"],
    scope: { workspaceId: "workspace-1" },
    signal: new AbortController().signal,
    sourceId: "host-local-file"
  });

  assert.deepEqual(
    tree.childrenByKey[ROOT_CHILDREN_KEY]?.entries.map(
      (entry) => entry.displayName
    ),
    ["Pictures"]
  );
  assert.equal(
    tree.childrenByKey[nodeRefKey(protectedFolder.ref)]?.error?.message,
    "EACCES: operation not permitted"
  );
});

test("filter tree terminates when folders form a cycle", async () => {
  const photos = folder("/workspace/photos", "photos");
  const nested = folder("/workspace/photos/nested", "nested");
  const entriesByNodeId: Record<string, ReferenceNode[]> = {
    [SOURCE_ROOT_NODE_ID]: [photos],
    [photos.ref.nodeId]: [nested],
    [nested.ref.nodeId]: [
      photos,
      file("/workspace/photos/nested/banner.jpg", "banner.jpg")
    ]
  };
  const aggregator = {
    async listChildren(_scope, node) {
      return {
        entries: entriesByNodeId[node.nodeId] ?? [],
        nextCursor: null
      };
    }
  } as ReferenceSourceAggregator;

  const tree = await buildReferenceSourcePickerFilteredTree({
    aggregator,
    filters: ["image"],
    scope: { workspaceId: "workspace-1" },
    signal: new AbortController().signal,
    sourceId: "workspace-file"
  });

  assert.deepEqual(
    tree.childrenByKey[ROOT_CHILDREN_KEY]?.entries.map(
      (entry) => entry.displayName
    ),
    ["photos"]
  );
  assert.deepEqual(
    tree.childrenByKey[nodeRefKey(photos.ref)]?.entries.map(
      (entry) => entry.displayName
    ),
    ["nested"]
  );
  assert.deepEqual(
    tree.childrenByKey[nodeRefKey(nested.ref)]?.entries.map(
      (entry) => entry.displayName
    ),
    ["photos", "banner.jpg"]
  );
});

test("filter tree still reports a source-root read failure", async () => {
  const aggregator = {
    async listChildren() {
      throw new Error("source unavailable");
    }
  } as unknown as ReferenceSourceAggregator;

  await assert.rejects(
    buildReferenceSourcePickerFilteredTree({
      aggregator,
      filters: ["image"],
      scope: { workspaceId: "workspace-1" },
      signal: new AbortController().signal,
      sourceId: "workspace-file"
    }),
    /source unavailable/
  );
});

function folder(nodeId: string, displayName: string): ReferenceNode {
  return {
    displayName,
    hasChildren: true,
    kind: "folder",
    ref: { nodeId, sourceId: "workspace-file" }
  };
}

function file(nodeId: string, displayName: string): ReferenceNode {
  return {
    displayName,
    kind: "file",
    ref: { nodeId, sourceId: "workspace-file" }
  };
}
