import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReferenceScope } from "../contracts/referenceSource.ts";
import {
  createReferenceListSource,
  type ReferenceListBackend,
  type ReferenceListRequest,
  type ReferenceListResult,
  type ReferenceListSearchRequest
} from "./referenceListSource.ts";
import { SOURCE_ROOT_NODE_ID } from "./referenceSourceAggregator.ts";

const scope: ReferenceScope = { workspaceId: "ws-1" };

function backendOf(byParent: Record<string, ReferenceListResult>): {
  backend: ReferenceListBackend;
  calls: ReferenceListRequest[];
} {
  const calls: ReferenceListRequest[] = [];
  return {
    calls,
    backend: {
      async list(_scope, request) {
        calls.push(request);
        return (
          byParent[request.parentGroupId ?? "__root__"] ?? {
            items: [],
            nextCursor: null
          }
        );
      }
    }
  };
}

const fakeAdapter = {
  openReference: async () => {},
  readReferencePreview: async () => null
};

function makeSource(
  byParent: Record<string, ReferenceListResult>,
  options: { preserveBackendOrder?: boolean } = {}
) {
  const { backend, calls } = backendOf(byParent);
  const source = createReferenceListSource({
    sourceId: "issue-file",
    label: "议题",
    capabilities: {
      searchable: false,
      previewable: true,
      paginated: true,
      navigable: true,
      filterable: true
    },
    isAvailable: () => true,
    backend,
    ...(options.preserveBackendOrder ? { preserveBackendOrder: true } : {}),
    adapter: fakeAdapter
  });
  return { source, calls };
}

test("根层级:协议 group/reference 映射成 folder/file 节点", async () => {
  const { source } = makeSource({
    __root__: {
      items: [
        { type: "group", id: "topic:t1", displayName: "T1", referenceCount: 3 },
        {
          type: "reference",
          reference: { path: "/ws/a.md", displayName: "a.md", sizeBytes: 10 }
        }
      ],
      nextCursor: "c1"
    }
  });
  const result = await source.listChildren(scope, { node: null });
  assert.equal(result.nextCursor, "c1");
  const folder = result.entries[0]!;
  const file = result.entries[1]!;
  assert.equal(folder.kind, "folder");
  assert.equal(folder.displayName, "T1");
  assert.equal(folder.childCount, 3);
  assert.ok(folder.ref.nodeId.startsWith("g:"));
  assert.equal(file.kind, "file");
  assert.equal(file.displayName, "a.md");
  assert.equal(file.sizeBytes, 10);
  assert.ok(file.ref.nodeId.startsWith("f:"));
});

test("source 配置保留 backend 返回顺序时阻止 picker 重排", async () => {
  const { source } = makeSource(
    {
      __root__: {
        items: [
          { type: "group", id: "project-new", displayName: "Untitled" },
          { type: "group", id: "project-old", displayName: "Alpha" }
        ],
        nextCursor: null
      }
    },
    { preserveBackendOrder: true }
  );

  const result = await source.listChildren(scope, { node: null });

  assert.equal(result.ordered, true);
  assert.deepEqual(
    result.entries.map((entry) => entry.displayName),
    ["Untitled", "Alpha"]
  );
});

test("reference.parentLabel 透传为节点 contextLabel,缺省时不带", async () => {
  const { source } = makeSource({
    __root__: {
      items: [
        {
          type: "reference",
          reference: { path: "/ws/cover.svg", parentLabel: "Prototype Design" }
        },
        { type: "reference", reference: { path: "/ws/plain.txt" } }
      ],
      nextCursor: null
    }
  });
  const result = await source.listChildren(scope, { node: null });
  assert.equal(result.entries[0]?.contextLabel, "Prototype Design");
  // 没填 parentLabel 的项不应带 contextLabel(UI 不展示不透明 nodeId)。
  assert.equal(result.entries[1]?.contextLabel, undefined);
});

test("search 把结果类型约束下推给 backend", async () => {
  let observedRequest: ReferenceListSearchRequest | undefined;
  const source = createReferenceListSource({
    sourceId: "workspace-file",
    label: "Workspace",
    capabilities: {
      searchable: true,
      previewable: true,
      paginated: false,
      navigable: true,
      filterable: true
    },
    isAvailable: () => true,
    adapter: fakeAdapter,
    backend: {
      async list() {
        return { items: [], nextCursor: null };
      },
      async search(_scope, request) {
        observedRequest = request;
        return {
          items: [{ type: "reference", reference: { path: "/ws/notes.md" } }],
          nextCursor: null
        };
      }
    }
  });

  const result = await source.search?.(scope, {
    query: "notes",
    kinds: ["file"],
    limit: 20
  });

  assert.deepEqual(observedRequest, {
    query: "notes",
    cursor: null,
    kinds: ["file"],
    limit: 20
  });
  assert.equal(result?.entries[0]?.kind, "file");
});

test("group.parentLabel 透传为节点 contextLabel,避免 UI 展示不透明 nodeId", async () => {
  const { source } = makeSource({
    __root__: {
      items: [
        {
          type: "group",
          id: "app:vibe-design|grp:23232",
          displayName: "23232",
          parentLabel: "Prototype Design / 23232"
        } as ReferenceListResult["items"][number]
      ],
      nextCursor: null
    }
  });
  const result = await source.listChildren(scope, { node: null });
  assert.equal(result.entries[0]?.contextLabel, "Prototype Design / 23232");
});

test("下钻:folder 节点的 nodeId 解码回 parentGroupId 原样传给 backend", async () => {
  const { source, calls } = makeSource({
    __root__: {
      items: [{ type: "group", id: "topic:特殊/id|x", displayName: "T" }],
      nextCursor: null
    },
    "topic:特殊/id|x": {
      items: [
        {
          type: "reference",
          reference: { path: "/ws/报告.md" }
        }
      ],
      nextCursor: null
    }
  });
  const root = await source.listChildren(scope, { node: null });
  const folder = root.entries[0]!;
  const children = await source.listChildren(scope, { node: folder.ref });
  // backend 第二次收到的 parentGroupId 应为原始(含特殊字符)id
  assert.equal(calls[1]?.parentGroupId, "topic:特殊/id|x");
  assert.equal(children.entries[0]?.displayName, "报告.md");
});

test("resolveSelection / file 节点产出 path,与现状一致", async () => {
  const { source } = makeSource({
    __root__: {
      items: [{ type: "reference", reference: { path: "/ws/x.png" } }],
      nextCursor: null
    }
  });
  const result = await source.listChildren(scope, { node: null });
  const fileNode = result.entries[0]!;
  assert.deepEqual(source.resolveSelection(fileNode), {
    path: "/ws/x.png",
    kind: "file",
    displayName: "x.png"
  });
});

test("resolveSelection / folder 节点产出原始 group id", async () => {
  const { source } = makeSource({
    __root__: {
      items: [
        {
          type: "group",
          id: "/ws/projects/demo",
          displayName: "demo"
        }
      ],
      nextCursor: null
    }
  });
  const result = await source.listChildren(scope, { node: null });
  const folderNode = result.entries[0]!;

  assert.deepEqual(source.resolveSelection(folderNode), {
    path: "/ws/projects/demo",
    kind: "folder",
    displayName: "demo"
  });
});

test("聚合器源根哨兵进入时,backend 收到 parentGroupId=null", async () => {
  const { source, calls } = makeSource({
    __root__: { items: [], nextCursor: null }
  });
  // 聚合器对源根传入 {sourceId, nodeId: SOURCE_ROOT_NODE_ID};源内 listChildren 收到的是 node=null
  await source.listChildren(scope, { node: null });
  assert.equal(calls[0]?.parentGroupId, null);
  // 确保哨兵不会被误当作 file/group(由聚合器层处理为 null,这里直接验 null 入参)
  assert.notEqual(SOURCE_ROOT_NODE_ID, "");
});

test("locateTarget:把 backend 分组 id 路径编成 NodeRef,且与 listChildren 编码一致", async () => {
  const calls: ReferenceListRequest[] = [];
  const source = createReferenceListSource({
    sourceId: "issue-file",
    label: "议题",
    capabilities: {
      searchable: false,
      previewable: true,
      paginated: true,
      navigable: true,
      filterable: true
    },
    isAvailable: () => true,
    adapter: fakeAdapter,
    backend: {
      async list(_scope, request) {
        calls.push(request);
        return { items: [], nextCursor: null };
      },
      async locate(_scope, params) {
        return params.issueId ? ["t:topic-1", "i:issue-1"] : null;
      }
    }
  });

  assert.equal(await source.locateTarget?.(scope, {}), null);

  const path = await source.locateTarget?.(scope, { issueId: "issue-1" });
  assert.equal(path?.length, 2);
  assert.equal(path?.[0]?.sourceId, "issue-file");

  // 关键:NodeRef 用回 listChildren 时,backend 应收到原始 group id(编码可逆、与 list 一致)。
  await source.listChildren(scope, { node: path[1]! });
  assert.equal(calls[0]?.parentGroupId, "i:issue-1");
});
