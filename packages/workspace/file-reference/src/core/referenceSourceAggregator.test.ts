import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ReferenceNode,
  ReferenceScope,
  ReferenceSourceService
} from "../contracts/referenceSource.ts";
import {
  appendReferencePage,
  dedupeReferenceNodes,
  nodeRefKey,
  normalizeReferenceNodeKind,
  selectedReferenceToWorkspaceFileReference,
  sortReferenceNodes
} from "./referenceSourceUtils.ts";
import {
  SOURCE_ROOT_NODE_ID,
  createReferenceSourceAggregator,
  createStaticReferenceSourceRegistry,
  isSourceRootNode
} from "./referenceSourceAggregator.ts";

const scope: ReferenceScope = { workspaceId: "ws-1" };

function fileNode(
  sourceId: string,
  nodeId: string,
  name = nodeId
): ReferenceNode {
  return { ref: { sourceId, nodeId }, kind: "file", displayName: name };
}
function folderNode(
  sourceId: string,
  nodeId: string,
  name = nodeId
): ReferenceNode {
  return { ref: { sourceId, nodeId }, kind: "folder", displayName: name };
}

test("nodeRefKey 区分 source 与 node", () => {
  assert.notEqual(
    nodeRefKey({ sourceId: "a", nodeId: "x" }),
    nodeRefKey({ sourceId: "b", nodeId: "x" })
  );
});

test("normalizeReferenceNodeKind 归一目录别名", () => {
  assert.equal(normalizeReferenceNodeKind("directory"), "folder");
  assert.equal(normalizeReferenceNodeKind("folder"), "folder");
  assert.equal(normalizeReferenceNodeKind("file"), "file");
  assert.equal(normalizeReferenceNodeKind(undefined), "file");
});

test("sortReferenceNodes folder 在前并按名排序", () => {
  const sorted = sortReferenceNodes([
    fileNode("s", "b.txt", "b.txt"),
    folderNode("s", "z", "z"),
    folderNode("s", "a", "a"),
    fileNode("s", "a.txt", "a.txt")
  ]);
  assert.deepEqual(
    sorted.map((n) => n.displayName),
    ["a", "z", "a.txt", "b.txt"]
  );
});

test("dedupe / appendReferencePage 按 node key 去重且不重排", () => {
  const page1 = [fileNode("s", "1"), fileNode("s", "2")];
  const page2 = [fileNode("s", "2"), fileNode("s", "3")];
  const merged = appendReferencePage(page1, page2);
  assert.deepEqual(
    merged.map((n) => n.ref.nodeId),
    ["1", "2", "3"]
  );
  assert.equal(dedupeReferenceNodes(merged).length, 3);
});

test("selectedReferenceToWorkspaceFileReference 形状兼容", () => {
  assert.deepEqual(
    selectedReferenceToWorkspaceFileReference({ path: "/a", kind: "file" }),
    { path: "/a", kind: "file" }
  );
  assert.deepEqual(
    selectedReferenceToWorkspaceFileReference({
      path: "/a",
      kind: "folder",
      displayName: "A",
      sizeBytes: 12,
      hostPath: "/Users/test/A",
      sourceId: "host-local-file"
    }),
    {
      path: "/a",
      kind: "folder",
      displayName: "A",
      sizeBytes: 12,
      hostPath: "/Users/test/A",
      sourceId: "host-local-file"
    }
  );
});

function fakeSource(
  overrides: Partial<ReferenceSourceService> & { id: string; order?: number }
): ReferenceSourceService {
  return {
    metadata: {
      id: overrides.id,
      label: overrides.id,
      order: overrides.order ?? 0
    },
    capabilities: { searchable: false, previewable: false, paginated: false },
    isAvailable: () => true,
    listChildren: async () => ({ entries: [], nextCursor: null }),
    resolveSelection: (node) => ({ path: node.ref.nodeId, kind: node.kind }),
    ...overrides
  };
}

test("registry 过滤 isAvailable 并按 order 排序", async () => {
  const registry = createStaticReferenceSourceRegistry([
    fakeSource({ id: "b", order: 2 }),
    fakeSource({ id: "hidden", order: 1, isAvailable: () => false }),
    fakeSource({ id: "a", order: 0 })
  ]);
  const sources = await registry.getSources(scope);
  assert.deepEqual(
    sources.map((s) => s.metadata.id),
    ["a", "b"]
  );
});

test("aggregator 根层级=每源一个 folder 节点", async () => {
  const registry = createStaticReferenceSourceRegistry([
    fakeSource({ id: "workspace-file", order: 0 }),
    fakeSource({ id: "app-artifact", order: 1 })
  ]);
  const agg = createReferenceSourceAggregator(registry);
  const root = await agg.listRoot(scope);
  assert.deepEqual(
    root.map((n) => [n.ref.sourceId, n.kind, isSourceRootNode(n.ref)]),
    [
      ["workspace-file", "folder", true],
      ["app-artifact", "folder", true]
    ]
  );
});

test("aggregator 源根节点下钻调用 source.listChildren(node:null)", async () => {
  let calledWithNode: unknown = "unset";
  const registry = createStaticReferenceSourceRegistry([
    fakeSource({
      id: "app-artifact",
      listChildren: async (_scope, input) => {
        calledWithNode = input.node;
        return { entries: [fileNode("app-artifact", "f1")], nextCursor: null };
      }
    })
  ]);
  const agg = createReferenceSourceAggregator(registry);
  await agg.listRoot(scope);
  const result = await agg.listChildren(scope, {
    sourceId: "app-artifact",
    nodeId: SOURCE_ROOT_NODE_ID
  });
  assert.equal(calledWithNode, null);
  assert.equal(result.entries.length, 1);
});

test("aggregator 委派 resolveSelection 到对应源", async () => {
  const registry = createStaticReferenceSourceRegistry([
    fakeSource({
      id: "workspace-file",
      resolveSelection: (node) => ({
        path: `/workspace/${node.ref.nodeId}`,
        kind: node.kind
      })
    })
  ]);
  const agg = createReferenceSourceAggregator(registry);
  await agg.listRoot(scope);
  const selected = agg.resolveSelection(fileNode("workspace-file", "a.md"));
  assert.deepEqual(selected, {
    path: "/workspace/a.md",
    kind: "file",
    sourceId: "workspace-file"
  });
});

test("aggregator 在确认阶段委派 source preparation 并保留 source identity", async () => {
  let receivedScope: ReferenceScope | null = null;
  let receivedSelection: unknown = null;
  const registry = createStaticReferenceSourceRegistry([
    fakeSource({
      id: "host-local-file",
      resolveSelection: (node) => ({
        path: node.ref.nodeId,
        hostPath: node.ref.nodeId,
        kind: node.kind
      }),
      prepareSelection: async (selectionScope, _node, selection) => {
        receivedScope = selectionScope;
        receivedSelection = selection;
        return {
          ...selection,
          path: "/var/cache/tsh/local-assets/ws-1/photo.png",
          hostPath: undefined
        };
      }
    })
  ]);
  const aggregator = createReferenceSourceAggregator(registry);
  await aggregator.listRoot(scope);

  const selected = await aggregator.prepareSelection(
    scope,
    fileNode("host-local-file", "opaque-handle", "photo.png")
  );

  assert.deepEqual(receivedScope, scope);
  assert.deepEqual(receivedSelection, {
    path: "opaque-handle",
    hostPath: "opaque-handle",
    kind: "file"
  });
  assert.deepEqual(selected, {
    path: "/var/cache/tsh/local-assets/ws-1/photo.png",
    hostPath: undefined,
    kind: "file",
    sourceId: "host-local-file"
  });
});

test("aggregator only delegates active provenance filters to capable sources", async () => {
  let unsupportedCalls = 0;
  let supportedInput: unknown = null;
  const registry = createStaticReferenceSourceRegistry([
    fakeSource({
      id: "unsupported",
      capabilities: {
        paginated: false,
        previewable: false,
        searchable: true
      },
      search: async () => {
        unsupportedCalls += 1;
        return { entries: [fileNode("unsupported", "wrong")] };
      }
    }),
    fakeSource({
      id: "supported",
      capabilities: {
        paginated: false,
        previewable: false,
        provenanceDimensions: ["agent"],
        searchable: true
      },
      search: async (_scope, input) => {
        supportedInput = input.provenanceFilter;
        return { entries: [fileNode("supported", "right")] };
      }
    })
  ]);
  const aggregator = createReferenceSourceAggregator(registry);
  await aggregator.listRoot(scope);
  const provenanceFilter = {
    agentTargetIds: ["agent-a"],
    memberIds: null
  };

  const unsupported = await aggregator.search(scope, "unsupported", {
    provenanceFilter,
    query: ""
  });
  const supported = await aggregator.search(scope, "supported", {
    provenanceFilter,
    query: ""
  });

  assert.equal(unsupportedCalls, 0);
  assert.deepEqual(unsupported.entries, []);
  assert.deepEqual(supportedInput, provenanceFilter);
  assert.equal(supported.entries[0]?.ref.nodeId, "right");
});
