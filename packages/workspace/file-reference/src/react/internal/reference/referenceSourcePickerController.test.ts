import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ListChildrenResult,
  NodeRef,
  ReferenceNode,
  SearchInput,
  SearchResult,
  SelectedReference
} from "../../../contracts/referenceSource.ts";
import type { ReferenceSourceService } from "../../../contracts/referenceSource.ts";
import type {
  ReferenceSourceAggregator,
  ReferenceSourceTab
} from "../../../core/referenceSourceAggregator.ts";
import { SOURCE_ROOT_NODE_ID } from "../../../core/referenceSourceAggregator.ts";
import { nodeRefKey } from "../../../core/referenceSourceUtils.ts";
import {
  ROOT_CHILDREN_KEY,
  SEARCH_PAGE_SIZE,
  createReferenceSourcePickerController
} from "./referenceSourcePickerController.ts";

const scope = { workspaceId: "ws-1" };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function folder(
  sourceId: string,
  nodeId: string,
  name = nodeId
): ReferenceNode {
  return { ref: { sourceId, nodeId }, kind: "folder", displayName: name };
}
function file(sourceId: string, nodeId: string, name = nodeId): ReferenceNode {
  return { ref: { sourceId, nodeId }, kind: "file", displayName: name };
}

interface FakeOptions {
  tabs: ReferenceSourceTab[];
  children: Record<string, ListChildrenResult>; // key = `${sourceId}:${nodeId}`
  search?: Record<string, SearchResult>; // key = `${sourceId}:${query}`
  onSearch?: (input: SearchInput) => void;
  searchImpl?: (input: SearchInput) => Promise<SearchResult>;
  /** navigable=true 的源(app/issue):confirm 时文件夹递归展开成文件。 */
  navigable?: Record<string, boolean>;
  /** locateTarget 返回的 NodeRef 路径(root → leaf),key = sourceId。 */
  locate?: Record<string, NodeRef[]>;
}

function fakeAggregator(options: FakeOptions): ReferenceSourceAggregator {
  return {
    listSources: async () => options.tabs,
    listRoot: async () => [],
    async listChildren(_scope, ref: NodeRef): Promise<ListChildrenResult> {
      return (
        options.children[`${ref.sourceId}:${ref.nodeId}`] ?? {
          entries: [],
          nextCursor: null
        }
      );
    },
    async search(_scope, sourceId, input): Promise<SearchResult> {
      options.onSearch?.(input);
      if (options.searchImpl) {
        return options.searchImpl(input);
      }
      return (
        options.search?.[`${sourceId}:${input.query}`] ?? {
          entries: [],
          nextCursor: null
        }
      );
    },
    open: async () => {},
    listOpenWithApplications: async () => [],
    openWithApplication: async () => {},
    openWithOtherApplication: async () => {},
    reveal: async () => {},
    readPreview: async () => null,
    resolveSelection(node): SelectedReference {
      return { path: node.ref.nodeId, kind: node.kind };
    },
    async prepareSelection(_scope, node): Promise<SelectedReference> {
      return { path: node.ref.nodeId, kind: node.kind };
    },
    locateTarget: async (_scope, sourceId) =>
      options.locate?.[sourceId] ?? null,
    getLoadedSource: (sourceId: string) =>
      options.navigable?.[sourceId]
        ? ({
            capabilities: { navigable: true }
          } as unknown as ReferenceSourceService)
        : undefined
  };
}

const tabsTwo: ReferenceSourceTab[] = [
  {
    sourceId: "workspace-file",
    label: "本地文件",
    capabilities: { searchable: true, previewable: true, paginated: false }
  },
  {
    sourceId: "app-artifact",
    label: "应用文件",
    capabilities: { searchable: false, previewable: true, paginated: true }
  }
];

test("open 加载 tabs、默认选中首个并加载其根", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      children: {
        [`workspace-file:${SOURCE_ROOT_NODE_ID}`]: {
          entries: [
            folder("workspace-file", "/a"),
            file("workspace-file", "/x.md")
          ],
          nextCursor: null
        }
      }
    }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  const snap = controller.getSnapshot();
  assert.equal(snap.activeSourceId, "workspace-file");
  assert.deepEqual(
    snap.tabs.map((t) => t.sourceId),
    ["workspace-file", "app-artifact"]
  );
  const root =
    snap.bySource["workspace-file"]?.childrenByKey[ROOT_CHILDREN_KEY];
  assert.equal(root?.loaded, true);
  // folder 在前
  assert.deepEqual(
    root?.entries.map((n) => n.ref.nodeId),
    ["/a", "/x.md"]
  );
});

test("首次加载保留 source 声明的业务顺序", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: [tabsTwo[1]!],
      children: {
        [`app-artifact:${SOURCE_ROOT_NODE_ID}`]: {
          entries: [
            folder("app-artifact", "project-new", "Untitled"),
            folder("app-artifact", "project-beta", "Beta"),
            folder("app-artifact", "project-alpha", "Alpha")
          ],
          nextCursor: null,
          ordered: true
        }
      }
    }),
    scope,
    searchDebounceMs: 0
  });

  controller.open();
  await flush();

  const root =
    controller.getSnapshot().bySource["app-artifact"]?.childrenByKey[
      ROOT_CHILDREN_KEY
    ];
  assert.deepEqual(
    root?.entries.map((node) => node.displayName),
    ["Untitled", "Beta", "Alpha"]
  );
});

test("toggleNode 展开 folder 并懒加载子节点", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      children: {
        [`workspace-file:${SOURCE_ROOT_NODE_ID}`]: {
          entries: [folder("workspace-file", "/a")],
          nextCursor: null
        },
        "workspace-file:/a": {
          entries: [file("workspace-file", "/a/1.md")],
          nextCursor: null
        }
      }
    }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  controller.toggleNode(folder("workspace-file", "/a"));
  await flush();
  const tab = controller.getSnapshot().bySource["workspace-file"];
  const key = nodeRefKey({ sourceId: "workspace-file", nodeId: "/a" });
  assert.equal(tab?.expandedKeys[key], true);
  assert.deepEqual(
    tab?.childrenByKey[key]?.entries.map((n) => n.ref.nodeId),
    ["/a/1.md"]
  );
});

test("refreshChildren reloads an already loaded app group", async () => {
  let appGroupFiles = [file("app-artifact", "old.png")];
  let appGroupLoadCount = 0;
  const appGroup = folder("app-artifact", "app:vibe-design", "Vibe Design");
  const controller = createReferenceSourcePickerController({
    aggregator: {
      ...fakeAggregator({
        tabs: [tabsTwo[1]!],
        children: {}
      }),
      async listChildren(_scope, ref: NodeRef): Promise<ListChildrenResult> {
        if (ref.nodeId === SOURCE_ROOT_NODE_ID) {
          return { entries: [appGroup], nextCursor: null };
        }
        if (ref.nodeId === appGroup.ref.nodeId) {
          appGroupLoadCount += 1;
          return { entries: appGroupFiles, nextCursor: null };
        }
        return { entries: [], nextCursor: null };
      }
    },
    scope,
    searchDebounceMs: 0
  });

  controller.open();
  await flush();
  controller.ensureChildren(appGroup);
  await flush();
  assert.equal(appGroupLoadCount, 1);

  appGroupFiles = [file("app-artifact", "new.png")];
  controller.refreshChildren(appGroup);
  await flush();

  const key = nodeRefKey(appGroup.ref);
  const entries =
    controller.getSnapshot().bySource["app-artifact"]?.childrenByKey[key]
      ?.entries ?? [];
  assert.equal(appGroupLoadCount, 2);
  assert.deepEqual(
    entries.map((node) => node.ref.nodeId),
    ["new.png"]
  );
});

test("failed app group loading is retained as content state instead of empty data", async () => {
  const appGroup = folder("app-artifact", "app:broken", "Broken App");
  const expected = new Error("reference endpoint unavailable");
  const controller = createReferenceSourcePickerController({
    aggregator: {
      ...fakeAggregator({ tabs: [tabsTwo[1]!], children: {} }),
      async listChildren(_scope, ref: NodeRef): Promise<ListChildrenResult> {
        if (ref.nodeId === SOURCE_ROOT_NODE_ID) {
          return { entries: [appGroup], nextCursor: null };
        }
        throw expected;
      }
    },
    scope,
    searchDebounceMs: 0
  });

  controller.open();
  await flush();
  controller.refreshChildren(appGroup);
  await flush();

  const state =
    controller.getSnapshot().bySource["app-artifact"]?.childrenByKey[
      nodeRefKey(appGroup.ref)
    ];
  assert.equal(state?.loaded, false);
  assert.equal(state?.loading, false);
  assert.equal(state?.entries.length, 0);
  assert.equal(state?.error, expected);
});

test("toggleSingleSelectionAndExpand single-selects and expands folders", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      children: {
        [`workspace-file:${SOURCE_ROOT_NODE_ID}`]: {
          entries: [folder("workspace-file", "/dir")],
          nextCursor: null
        },
        "workspace-file:/dir": {
          entries: [file("workspace-file", "/dir/a.md")],
          nextCursor: null
        }
      }
    }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();

  controller.toggleSingleSelectionAndExpand(file("workspace-file", "/note.md"));
  assert.deepEqual(
    controller.getSnapshot().selection.map((node) => node.ref.nodeId),
    ["/note.md"]
  );

  controller.toggleSingleSelectionAndExpand(folder("workspace-file", "/dir"));
  await flush();
  const dirKey = nodeRefKey({ sourceId: "workspace-file", nodeId: "/dir" });
  let snapshot = controller.getSnapshot();
  assert.equal(snapshot.bySource["workspace-file"]?.expandedKeys[dirKey], true);
  assert.deepEqual(
    snapshot.bySource["workspace-file"]?.childrenByKey[dirKey]?.entries.map(
      (node) => node.ref.nodeId
    ),
    ["/dir/a.md"]
  );
  assert.deepEqual(
    snapshot.selection.map((node) => node.ref.nodeId),
    ["/dir"]
  );

  controller.toggleSingleSelectionAndExpand(folder("workspace-file", "/dir"));
  snapshot = controller.getSnapshot();
  assert.deepEqual(
    snapshot.selection.map((node) => node.ref.nodeId),
    []
  );

  controller.toggleSingleSelectionAndExpand(folder("workspace-file", "/dir"));
  snapshot = controller.getSnapshot();
  assert.deepEqual(
    snapshot.selection.map((node) => node.ref.nodeId),
    ["/dir"]
  );

  controller.toggleSelection(file("workspace-file", "/note.md"));
  assert.deepEqual(
    controller.getSnapshot().selection.map((node) => node.ref.nodeId),
    ["/dir", "/note.md"]
  );

  controller.toggleSingleSelectionAndExpand(file("workspace-file", "/note.md"));
  assert.deepEqual(
    controller.getSnapshot().selection.map((node) => node.ref.nodeId),
    ["/dir", "/note.md"]
  );

  controller.toggleSingleSelectionAndExpand(
    file("workspace-file", "/other.md")
  );
  assert.deepEqual(
    controller.getSnapshot().selection.map((node) => node.ref.nodeId),
    ["/dir", "/note.md"]
  );

  controller.toggleSingleSelectionAndExpand(folder("workspace-file", "/dir"));
  snapshot = controller.getSnapshot();
  assert.equal(snapshot.bySource["workspace-file"]?.expandedKeys[dirKey], true);
  assert.deepEqual(
    snapshot.selection.map((node) => node.ref.nodeId),
    ["/dir", "/note.md"]
  );
});

test("single selection mode replaces the previous selection", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({ tabs: tabsTwo, children: {} }),
    scope,
    searchDebounceMs: 0,
    selectionMode: "single"
  });
  controller.open();
  await flush();

  controller.toggleSelection(folder("workspace-file", "/first"));
  controller.toggleSelection(folder("workspace-file", "/second"));

  assert.deepEqual(
    controller.getSnapshot().selection.map((node) => node.ref.nodeId),
    ["/second"]
  );
});

test("createDirectory delegates to the active source and selects the created folder", async () => {
  const parent = folder("workspace-file", "/projects", "projects");
  const created = folder(
    "workspace-file",
    "/projects/new-project",
    "new-project"
  );
  const calls: Array<{ parent: ReferenceNode | null; name: string }> = [];
  const controller = createReferenceSourcePickerController({
    aggregator: {
      ...fakeAggregator({
        tabs: tabsTwo,
        children: {
          [`workspace-file:${SOURCE_ROOT_NODE_ID}`]: {
            entries: [parent],
            nextCursor: null
          },
          "workspace-file:/projects": {
            entries: [
              folder("workspace-file", "/projects/existing", "existing")
            ],
            nextCursor: null
          }
        }
      }),
      async createDirectory(_scope, sourceId, input) {
        assert.equal(sourceId, "workspace-file");
        calls.push(input);
        return created;
      }
    },
    scope,
    searchDebounceMs: 0,
    selectionMode: "single"
  });
  controller.open();
  await flush();
  controller.ensureChildren(parent);
  await flush();

  const result = await controller.createDirectory(parent, "new-project");

  assert.equal(result, created);
  assert.deepEqual(calls, [{ parent, name: "new-project" }]);
  const parentKey = nodeRefKey(parent.ref);
  const snapshot = controller.getSnapshot();
  assert.equal(
    snapshot.bySource["workspace-file"]?.expandedKeys[parentKey],
    true
  );
  assert.deepEqual(
    snapshot.bySource["workspace-file"]?.childrenByKey[parentKey]?.entries.map(
      (node) => node.ref.nodeId
    ),
    ["/projects/existing", "/projects/new-project"]
  );
  assert.deepEqual(snapshot.selection, [created]);
});

test("expandNode 展开定位到的 folder 并懒加载子节点", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      children: {
        [`app-artifact:${SOURCE_ROOT_NODE_ID}`]: {
          entries: [folder("app-artifact", "g1", "分组一")],
          nextCursor: null
        },
        "app-artifact:g1": {
          entries: [folder("app-artifact", "task-1", "任务一")],
          nextCursor: null
        },
        "app-artifact:task-1": {
          entries: [file("app-artifact", "artifact-1", "产物.md")],
          nextCursor: null
        }
      }
    }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  controller.setActiveSource("app-artifact");
  await flush();

  controller.expandNode(folder("app-artifact", "task-1", "任务一"));
  await flush();

  const taskKey = nodeRefKey({
    sourceId: "app-artifact",
    nodeId: "task-1"
  });
  const tab = controller.getSnapshot().bySource["app-artifact"];
  assert.equal(tab?.expandedKeys[taskKey], true);
  assert.deepEqual(
    tab?.childrenByKey[taskKey]?.entries.map((node) => node.displayName),
    ["产物.md"]
  );

  controller.expandNode(folder("app-artifact", "task-1", "任务一"));
  await flush();
  assert.equal(
    controller.getSnapshot().bySource["app-artifact"]?.expandedKeys[taskKey],
    true
  );
});

test("loadMore 按 cursor 累积分页(保序不重排)", async () => {
  const children: Record<string, ListChildrenResult> = {
    [`app-artifact:${SOURCE_ROOT_NODE_ID}`]: {
      entries: [file("app-artifact", "p1a"), file("app-artifact", "p1b")],
      nextCursor: "c1"
    }
  };
  const controller = createReferenceSourcePickerController({
    aggregator: {
      ...fakeAggregator({ tabs: tabsTwo, children }),
      // 第二页:cursor=c1 时返回下一页
      async listChildren(_scope, ref, input) {
        if (ref.nodeId === SOURCE_ROOT_NODE_ID && input?.cursor === "c1") {
          return {
            entries: [file("app-artifact", "p2a"), file("app-artifact", "p1b")],
            nextCursor: null
          };
        }
        return (
          children[`${ref.sourceId}:${ref.nodeId}`] ?? {
            entries: [],
            nextCursor: null
          }
        );
      }
    },
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  controller.setActiveSource("app-artifact");
  await flush();
  let root =
    controller.getSnapshot().bySource["app-artifact"]?.childrenByKey[
      ROOT_CHILDREN_KEY
    ];
  assert.equal(root?.nextCursor, "c1");
  controller.loadMore(null);
  await flush();
  root =
    controller.getSnapshot().bySource["app-artifact"]?.childrenByKey[
      ROOT_CHILDREN_KEY
    ];
  // append + 去重(p1b 不重复),保序
  assert.deepEqual(
    root?.entries.map((n) => n.ref.nodeId),
    ["p1a", "p1b", "p2a"]
  );
  assert.equal(root?.nextCursor, null);
});

test("loadMoreSourceRoot 拉取指定(非 active)源根的下一页", async () => {
  const children: Record<string, ListChildrenResult> = {
    [`app-artifact:${SOURCE_ROOT_NODE_ID}`]: {
      entries: [file("app-artifact", "app1"), file("app-artifact", "app2")],
      nextCursor: "c1"
    }
  };
  const controller = createReferenceSourcePickerController({
    aggregator: {
      ...fakeAggregator({ tabs: tabsTwo, children }),
      async listChildren(_scope, ref, input) {
        if (
          ref.sourceId === "app-artifact" &&
          ref.nodeId === SOURCE_ROOT_NODE_ID &&
          input?.cursor === "c1"
        ) {
          return {
            entries: [file("app-artifact", "app3")],
            nextCursor: null
          };
        }
        return (
          children[`${ref.sourceId}:${ref.nodeId}`] ?? {
            entries: [],
            nextCursor: null
          }
        );
      }
    },
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  // active 源为首个(tabsTwo[0]),显式为非 active 的 "app-artifact" 源预载根再拉下一页。
  controller.ensureSourceRoot("app-artifact");
  await flush();
  let root =
    controller.getSnapshot().bySource["app-artifact"]?.childrenByKey[
      ROOT_CHILDREN_KEY
    ];
  assert.equal(root?.nextCursor, "c1");
  controller.loadMoreSourceRoot("app-artifact");
  await flush();
  root =
    controller.getSnapshot().bySource["app-artifact"]?.childrenByKey[
      ROOT_CHILDREN_KEY
    ];
  assert.deepEqual(
    root?.entries.map((n) => n.ref.nodeId),
    ["app1", "app2", "app3"]
  );
  assert.equal(root?.nextCursor, null);
});

test("search 在当前 tab 生效", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      children: {
        [`workspace-file:${SOURCE_ROOT_NODE_ID}`]: {
          entries: [],
          nextCursor: null
        }
      },
      search: {
        "workspace-file:report": {
          entries: [file("workspace-file", "/report.md", "report.md")],
          nextCursor: null
        }
      }
    }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  controller.setSearchQuery("report");
  await flush();
  const tab = controller.getSnapshot().bySource["workspace-file"];
  assert.equal(tab?.mode, "search");
  assert.deepEqual(
    tab?.searchEntries.map((n) => n.ref.nodeId),
    ["/report.md"]
  );
  // 清空回 browse
  controller.setSearchQuery("");
  await flush();
  assert.equal(
    controller.getSnapshot().bySource["workspace-file"]?.mode,
    "browse"
  );
});

test("provenance-only filtering enters query mode and reaches the source before paging", async () => {
  const searchInputs: SearchInput[] = [];
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      children: {},
      onSearch: (input) => {
        searchInputs.push(input);
      }
    }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();

  controller.setProvenanceFilter({
    agentTargetIds: ["agent-a"],
    memberIds: null
  });
  await flush();

  assert.equal(
    controller.getSnapshot().bySource["workspace-file"]?.mode,
    "search"
  );
  const searchInput = searchInputs.at(-1);
  assert.deepEqual(searchInput?.provenanceFilter, {
    agentTargetIds: ["agent-a"],
    memberIds: null
  });
  assert.equal(searchInput?.query, "");
  assert.equal(searchInput?.limit, SEARCH_PAGE_SIZE);
});

test("file-type filters keep browse mode until a keyword search starts", async () => {
  const searchInputs: SearchInput[] = [];
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      children: {
        [`workspace-file:${SOURCE_ROOT_NODE_ID}`]: {
          entries: [
            folder("workspace-file", "/docs", "docs"),
            file("workspace-file", "/photo.png", "photo.png")
          ],
          nextCursor: null
        }
      },
      onSearch: (input) => searchInputs.push(input)
    }),
    scope,
    searchDebounceMs: 0,
    searchResultKind: "file"
  });
  controller.open();
  await flush();

  controller.setSearchFilters(["image"]);
  await flush();

  assert.equal(
    controller.getSnapshot().bySource["workspace-file"]?.mode,
    "browse"
  );
  assert.equal(searchInputs.length, 0);

  controller.setActiveSource("app-artifact");
  await flush();
  assert.equal(
    controller.getSnapshot().bySource["app-artifact"]?.mode,
    "browse"
  );
  assert.deepEqual(
    controller.getSnapshot().bySource["app-artifact"]?.searchFilters,
    ["image"]
  );
  assert.equal(searchInputs.length, 0);

  controller.setActiveSource("workspace-file");
  await flush();

  controller.setSearchQuery("photo");
  await flush();

  assert.equal(searchInputs.length, 1);
  assert.deepEqual(searchInputs[0]?.filters, ["image"]);
  assert.deepEqual(searchInputs[0]?.kinds, ["file"]);
});

test("semantically equal provenance filters do not repeat the active search", async () => {
  const searchInputs: SearchInput[] = [];
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      children: {},
      onSearch: (input) => searchInputs.push(input)
    }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();

  controller.setProvenanceFilter({
    agentTargetIds: ["agent-b", "agent-a"],
    memberIds: null
  });
  await flush();
  assert.equal(searchInputs.length, 1);

  controller.setProvenanceFilter({
    agentTargetIds: ["agent-a", "agent-b"],
    memberIds: null
  });
  await flush();

  assert.equal(searchInputs.length, 1);
});

test("changing provenance filters aborts the stale request before debounce", async () => {
  let resolveFirst: ((result: SearchResult) => void) | undefined;
  const searchInputs: SearchInput[] = [];
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      children: {},
      searchImpl: (input) => {
        searchInputs.push(input);
        if (searchInputs.length === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ entries: [], nextCursor: null });
      }
    }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();

  controller.setProvenanceFilter({
    agentTargetIds: ["agent-a"],
    memberIds: null
  });
  await flush();
  assert.equal(searchInputs.length, 1);
  assert.equal(searchInputs[0]?.signal?.aborted, false);

  controller.setProvenanceFilter({
    agentTargetIds: ["agent-b"],
    memberIds: null
  });
  assert.equal(searchInputs[0]?.signal?.aborted, true);

  resolveFirst?.({ entries: [file("workspace-file", "/stale.md")] });
  await flush();
  assert.equal(searchInputs.length, 2);
  assert.deepEqual(searchInputs[1]?.provenanceFilter, {
    agentTargetIds: ["agent-b"],
    memberIds: null
  });
  assert.deepEqual(
    controller
      .getSnapshot()
      .bySource["workspace-file"]?.searchEntries.map((node) => node.ref.nodeId),
    []
  );
});

test("search 保留 source 返回的相关性顺序", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      children: {
        [`workspace-file:${SOURCE_ROOT_NODE_ID}`]: {
          entries: [],
          nextCursor: null
        }
      },
      search: {
        "workspace-file:load_log": {
          entries: [
            file("workspace-file", "/Movies/load_log", "load_log"),
            folder(
              "workspace-file",
              "/Music/downloaded_catalog_data",
              "downloaded_catalog_data"
            )
          ],
          nextCursor: null
        }
      }
    }),
    scope,
    searchDebounceMs: 0
  });

  controller.open();
  await flush();
  controller.setSearchQuery("load_log");
  await flush();

  assert.deepEqual(
    controller
      .getSnapshot()
      .bySource["workspace-file"]?.searchEntries.map((node) => node.ref.nodeId),
    ["/Movies/load_log", "/Music/downloaded_catalog_data"]
  );
});

test("setSearchQuery 把选中分组 nodeId 作为 withinNodeId 透传给 aggregator.search", async () => {
  const searchInputs: Array<{
    sourceId: string;
    withinNodeId?: string | null;
  }> = [];
  const aggregator = fakeAggregator({
    tabs: tabsTwo,
    children: {
      [`workspace-file:${SOURCE_ROOT_NODE_ID}`]: {
        entries: [],
        nextCursor: null
      }
    }
  });
  const baseSearch = aggregator.search.bind(aggregator);
  aggregator.search = async (s, sourceId, input) => {
    searchInputs.push({ sourceId, withinNodeId: input.withinNodeId ?? null });
    return baseSearch(s, sourceId, input);
  };
  const controller = createReferenceSourcePickerController({
    aggregator,
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();

  // 带分组范围搜索 → withinNodeId 透传。
  controller.setSearchQuery("report", "g:app-1");
  await flush();
  assert.deepEqual(searchInputs.at(-1), {
    sourceId: "workspace-file",
    withinNodeId: "g:app-1"
  });
  assert.equal(
    controller.getSnapshot().bySource["workspace-file"]?.searchScopeNodeId,
    "g:app-1"
  );

  // 搜索中切换分组 → 以新范围重搜。
  controller.setSearchScope("g:app-2");
  await flush();
  assert.deepEqual(searchInputs.at(-1), {
    sourceId: "workspace-file",
    withinNodeId: "g:app-2"
  });

  // 范围未变 → 不重复搜索。
  const before = searchInputs.length;
  controller.setSearchScope("g:app-2");
  await flush();
  assert.equal(searchInputs.length, before);
});

test("搜索中切源 → 把当前查询带到目标源并在其下重搜", async () => {
  const searchInputs: Array<{ sourceId: string; query: string }> = [];
  const tabs: ReferenceSourceTab[] = [
    {
      sourceId: "source-a",
      label: "源 A",
      capabilities: { searchable: true, previewable: true, paginated: false }
    },
    {
      sourceId: "source-b",
      label: "源 B",
      capabilities: { searchable: true, previewable: true, paginated: false }
    }
  ];
  const aggregator = fakeAggregator({
    tabs,
    children: {
      [`source-a:${SOURCE_ROOT_NODE_ID}`]: { entries: [], nextCursor: null },
      [`source-b:${SOURCE_ROOT_NODE_ID}`]: { entries: [], nextCursor: null }
    },
    search: {
      "source-a:report": {
        entries: [file("source-a", "/a/report.md", "report.md")],
        nextCursor: null
      },
      "source-b:report": {
        entries: [file("source-b", "b:report", "report.md")],
        nextCursor: null
      }
    }
  });
  const baseSearch = aggregator.search.bind(aggregator);
  aggregator.search = async (s, sourceId, input) => {
    searchInputs.push({ sourceId, query: input.query });
    return baseSearch(s, sourceId, input);
  };
  const controller = createReferenceSourcePickerController({
    aggregator,
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();

  // 在源 A 搜索 "report"。
  controller.setSearchQuery("report");
  await flush();
  assert.equal(searchInputs.at(-1)?.sourceId, "source-a");

  // 切到源 B → 自动带 "report" 重搜,源 B 进入搜索态并出结果。
  controller.setActiveSource("source-b");
  await flush();
  assert.deepEqual(searchInputs.at(-1), {
    sourceId: "source-b",
    query: "report"
  });
  const tabB = controller.getSnapshot().bySource["source-b"];
  assert.equal(tabB?.mode, "search");
  assert.equal(tabB?.searchQuery, "report");
  assert.deepEqual(
    tabB?.searchEntries.map((n) => n.ref.nodeId),
    ["b:report"]
  );

  // 无查询时切源 → 不发起搜索,回浏览态。
  controller.setSearchQuery("");
  await flush();
  const beforeIdle = searchInputs.length;
  controller.setActiveSource("source-a");
  await flush();
  assert.equal(searchInputs.length, beforeIdle);
  assert.equal(controller.getSnapshot().bySource["source-a"]?.mode, "browse");
});

test("搜索中切源到指定分组时直接用目标分组范围搜索", async () => {
  const searchInputs: Array<{
    sourceId: string;
    withinNodeId?: string | null;
  }> = [];
  const tabs: ReferenceSourceTab[] = [
    {
      sourceId: "source-a",
      label: "源 A",
      capabilities: { searchable: true, previewable: true, paginated: false }
    },
    {
      sourceId: "source-b",
      label: "源 B",
      capabilities: { searchable: true, previewable: true, paginated: false }
    }
  ];
  const aggregator = fakeAggregator({
    tabs,
    children: {
      [`source-a:${SOURCE_ROOT_NODE_ID}`]: { entries: [], nextCursor: null },
      [`source-b:${SOURCE_ROOT_NODE_ID}`]: { entries: [], nextCursor: null }
    }
  });
  const baseSearch = aggregator.search.bind(aggregator);
  aggregator.search = async (s, sourceId, input) => {
    searchInputs.push({
      sourceId,
      withinNodeId: input.withinNodeId ?? null
    });
    return baseSearch(s, sourceId, input);
  };
  const controller = createReferenceSourcePickerController({
    aggregator,
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();

  controller.setSearchQuery("report");
  await flush();
  controller.setActiveSource("source-b", "recent-group");
  await flush();

  assert.deepEqual(searchInputs.at(-1), {
    sourceId: "source-b",
    withinNodeId: "recent-group"
  });
  assert.equal(
    controller.getSnapshot().bySource["source-b"]?.searchScopeNodeId,
    "recent-group"
  );
});

test("跨 tab 选中累积,confirm 归一为 SelectedReference[]", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({ tabs: tabsTwo, children: {} }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  controller.toggleSelection(file("workspace-file", "/a.md"));
  controller.toggleSelection(file("app-artifact", "app:x|ref:enc"));
  // 本地源(非 navigable)文件夹:保持单条 folder 引用。
  controller.toggleSelection(folder("workspace-file", "/dir"));
  const selected = await controller.confirm();
  assert.deepEqual(selected, [
    { path: "/a.md", kind: "file" },
    { path: "app:x|ref:enc", kind: "file" },
    { path: "/dir", kind: "folder" }
  ]);
  // 再次 toggle 取消文件
  controller.toggleSelection(file("workspace-file", "/a.md"));
  assert.equal((await controller.confirm()).length, 2);
});

test("app/issue 源文件夹:confirm 递归枚举展开成逐个文件引用", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      navigable: { "app-artifact": true },
      children: {
        // 文件夹 g:1 下:子文件夹 g:2 + 文件 f:a
        "app-artifact:g:1": {
          entries: [folder("app-artifact", "g:2"), file("app-artifact", "f:a")],
          nextCursor: null
        },
        // 子文件夹 g:2 下:文件 f:b、f:c
        "app-artifact:g:2": {
          entries: [file("app-artifact", "f:b"), file("app-artifact", "f:c")],
          nextCursor: null
        }
      }
    }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  controller.toggleSelection(folder("app-artifact", "g:1"));
  const selected = await controller.confirm();
  // 递归深入子文件夹,文件夹本身不入选,只产出文件;顺序为遍历序。
  assert.deepEqual(
    selected.map((ref) => ref.path),
    ["f:b", "f:c", "f:a"]
  );
  assert.ok(selected.every((ref) => ref.kind === "file"));
});

test("confirmGrouped:navigable 源文件夹折叠成一个 bundle,松散文件单列", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      navigable: { "app-artifact": true },
      children: {
        "app-artifact:g:1": {
          entries: [folder("app-artifact", "g:2"), file("app-artifact", "f:a")],
          nextCursor: null
        },
        "app-artifact:g:2": {
          entries: [file("app-artifact", "f:b"), file("app-artifact", "f:c")],
          nextCursor: null
        }
      }
    }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  // 单独选一个本地文件 + 一个 app 项目文件夹。
  controller.toggleSelection(file("workspace-file", "/a.md"));
  controller.toggleSelection(folder("app-artifact", "g:1", "项目A"));
  const grouped = await controller.confirmGrouped();
  // 松散文件保持单条;app 文件夹折叠成一个 bundle(不再递归展开文件,确认即时)。
  assert.deepEqual(
    grouped.files.map((ref) => ref.path),
    ["/a.md"]
  );
  assert.equal(grouped.bundles.length, 1);
  assert.equal(grouped.bundles[0]?.root.ref.nodeId, "g:1");
  assert.equal(grouped.bundles[0]?.root.displayName, "项目A");
});

test("confirmGrouped 可按调用方过滤后的 selection 确认", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      children: {},
      navigable: { "app-artifact": true }
    }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  const hostFile = file("host-local-file", "/a.png");
  const hostFolder = folder("host-local-file", "/Downloads");
  controller.toggleSelection(hostFile);
  controller.toggleSelection(hostFolder);

  const grouped = await controller.confirmGrouped([hostFile]);

  assert.deepEqual(
    grouped.files.map((ref) => ref.path),
    ["/a.png"]
  );
  assert.equal(grouped.bundles.length, 0);
});

test("close 后丢弃迟到的浏览结果", async () => {
  let resolveChildren!: (value: ListChildrenResult) => void;
  const pending = new Promise<ListChildrenResult>((resolve) => {
    resolveChildren = resolve;
  });
  const controller = createReferenceSourcePickerController({
    aggregator: {
      ...fakeAggregator({ tabs: tabsTwo, children: {} }),
      listChildren: () => pending
    },
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  controller.close();
  resolveChildren({
    entries: [file("workspace-file", "/late.md")],
    nextCursor: null
  });
  await flush();
  const root =
    controller.getSnapshot().bySource["workspace-file"]?.childrenByKey[
      ROOT_CHILDREN_KEY
    ];
  assert.notEqual(
    root?.entries.some((n) => n.ref.nodeId === "/late.md"),
    true
  );
});

test("并发取数:慢根加载不被另一 key 的取数作废(按 key 隔离 sequence)", async () => {
  // 复现「本地-个人」回归:open 触发根(ROOT_CHILDREN_KEY)预取尚未返回时,
  // 进入某分组又触发另一 key 的取数。全局单 sequence 会把迟到的根结果丢弃、
  // 令根 loading 永不清除;按 key 隔离后两者互不影响。
  let resolveRoot!: (value: ListChildrenResult) => void;
  const pendingRoot = new Promise<ListChildrenResult>((resolve) => {
    resolveRoot = resolve;
  });
  const controller = createReferenceSourcePickerController({
    aggregator: {
      ...fakeAggregator({ tabs: tabsTwo, children: {} }),
      listChildren: (_scope, ref: NodeRef) =>
        ref.nodeId === SOURCE_ROOT_NODE_ID
          ? pendingRoot
          : Promise.resolve({
              entries: [file("workspace-file", "/group/a.md")],
              nextCursor: null
            })
    },
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  // 根预取在途时,进入一个分组(不同 key)并完成其取数 —— 这会推进全局计数。
  controller.ensureChildren(folder("workspace-file", "/group"));
  await flush();
  // 现在根才返回:旧实现里它已被作废(sequence 不匹配)。
  resolveRoot({
    entries: [file("workspace-file", "/root.md")],
    nextCursor: null
  });
  await flush();
  const root =
    controller.getSnapshot().bySource["workspace-file"]?.childrenByKey[
      ROOT_CHILDREN_KEY
    ];
  assert.equal(root?.loading, false);
  assert.equal(root?.loaded, true);
  assert.equal(
    root?.entries.some((n) => n.ref.nodeId === "/root.md"),
    true
  );
});

test("locatePath 把定位目标解析为真实节点路径(root → leaf)", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({
      tabs: tabsTwo,
      children: {
        [`app-artifact:${SOURCE_ROOT_NODE_ID}`]: {
          entries: [folder("app-artifact", "g1", "分组一")],
          nextCursor: null
        },
        "app-artifact:g1": {
          entries: [folder("app-artifact", "i1", "事项一")],
          nextCursor: null
        }
      },
      locate: {
        "app-artifact": [
          { sourceId: "app-artifact", nodeId: "g1" },
          { sourceId: "app-artifact", nodeId: "i1" }
        ]
      }
    }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  const path = await controller.locatePath({
    sourceId: "app-artifact",
    params: { issueId: "i1" }
  });
  // 返回真实节点(带 displayName),供「打开即定位」一次性应用面包屑/焦点。
  assert.deepEqual(
    path.map((node) => node.ref.nodeId),
    ["g1", "i1"]
  );
  assert.deepEqual(
    path.map((node) => node.displayName),
    ["分组一", "事项一"]
  );
});

test("locatePath follows pagination while resolving the target path", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: {
      ...fakeAggregator({
        tabs: tabsTwo,
        children: {
          [`app-artifact:${SOURCE_ROOT_NODE_ID}`]: {
            entries: [folder("app-artifact", "topic-1", "主题一")],
            nextCursor: null
          },
          "app-artifact:topic-1": {
            entries: [folder("app-artifact", "issue-old", "旧事项")],
            nextCursor: "page-2"
          }
        },
        locate: {
          "app-artifact": [
            { sourceId: "app-artifact", nodeId: "topic-1" },
            { sourceId: "app-artifact", nodeId: "issue-target" }
          ]
        }
      }),
      async listChildren(_scope, ref, input): Promise<ListChildrenResult> {
        if (ref.sourceId === "app-artifact" && ref.nodeId === "topic-1") {
          return input?.cursor === "page-2"
            ? {
                entries: [folder("app-artifact", "issue-target", "目标事项")],
                nextCursor: null
              }
            : {
                entries: [folder("app-artifact", "issue-old", "旧事项")],
                nextCursor: "page-2"
              };
        }
        return fakeAggregator({
          tabs: tabsTwo,
          children: {
            [`app-artifact:${SOURCE_ROOT_NODE_ID}`]: {
              entries: [folder("app-artifact", "topic-1", "主题一")],
              nextCursor: null
            }
          }
        }).listChildren(_scope, ref, input);
      }
    },
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();

  const path = await controller.locatePath({
    sourceId: "app-artifact",
    params: { issueId: "issue-target", topicId: "topic-1" }
  });

  assert.deepEqual(
    path.map((node) => node.ref.nodeId),
    ["topic-1", "issue-target"]
  );
  assert.deepEqual(
    path.map((node) => node.displayName),
    ["主题一", "目标事项"]
  );
});

test("locatePath keeps paged parent children so the located target can render", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: {
      ...fakeAggregator({
        tabs: tabsTwo,
        children: {
          [`app-artifact:${SOURCE_ROOT_NODE_ID}`]: {
            entries: [folder("app-artifact", "topic-1", "主题一")],
            nextCursor: null
          },
          "app-artifact:topic-1": {
            entries: [folder("app-artifact", "issue-old", "旧事项")],
            nextCursor: "page-2"
          }
        },
        locate: {
          "app-artifact": [
            { sourceId: "app-artifact", nodeId: "topic-1" },
            { sourceId: "app-artifact", nodeId: "issue-target" }
          ]
        }
      }),
      async listChildren(_scope, ref, input): Promise<ListChildrenResult> {
        if (ref.sourceId === "app-artifact" && ref.nodeId === "topic-1") {
          return input?.cursor === "page-2"
            ? {
                entries: [folder("app-artifact", "issue-target", "目标事项")],
                nextCursor: null
              }
            : {
                entries: [folder("app-artifact", "issue-old", "旧事项")],
                nextCursor: "page-2"
              };
        }
        return fakeAggregator({
          tabs: tabsTwo,
          children: {
            [`app-artifact:${SOURCE_ROOT_NODE_ID}`]: {
              entries: [folder("app-artifact", "topic-1", "主题一")],
              nextCursor: null
            }
          }
        }).listChildren(_scope, ref, input);
      }
    },
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();

  await controller.locatePath({
    sourceId: "app-artifact",
    params: { issueId: "issue-target", topicId: "topic-1" }
  });

  const topicKey = nodeRefKey({
    sourceId: "app-artifact",
    nodeId: "topic-1"
  });
  assert.deepEqual(
    controller
      .getSnapshot()
      .bySource["app-artifact"]?.childrenByKey[topicKey]?.entries.map(
        (node) => node.ref.nodeId
      ),
    ["issue-old", "issue-target"]
  );
});

test("locatePath 源不支持定位 / 未找到时返回空路径", async () => {
  const controller = createReferenceSourcePickerController({
    aggregator: fakeAggregator({ tabs: tabsTwo, children: {} }),
    scope,
    searchDebounceMs: 0
  });
  controller.open();
  await flush();
  assert.deepEqual(
    await controller.locatePath({ sourceId: "app-artifact", params: {} }),
    []
  );
});
