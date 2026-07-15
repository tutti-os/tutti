import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ReferenceNode } from "../../../contracts/referenceSource.ts";
import type {
  ReferenceSourceAggregator,
  ReferenceSourceTab
} from "../../../core/referenceSourceAggregator.ts";
import { useReferenceSourcePickerView } from "./useReferenceSourcePickerView.ts";

type PickerView = ReturnType<typeof useReferenceSourcePickerView>;
type JsdomModule = {
  JSDOM: new (html: string) => {
    window: Window & typeof globalThis;
  };
};

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as JsdomModule;

test("reference source picker caches open-with applications by file type", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousActEnvironment = (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  let root: Root | null = null;
  try {
    const container = dom.window.document.getElementById("root");
    assert.ok(container);

    let loadCount = 0;
    const applications = [
      {
        applicationPath: "/Applications/Preview.app",
        iconDataUrl: null,
        name: "Preview"
      }
    ];
    const aggregator = createOpenWithAggregator(async () => {
      loadCount += 1;
      return applications;
    });
    let latestView: PickerView | null = null;

    function Harness() {
      latestView = useReferenceSourcePickerView({
        aggregator,
        onClose() {},
        onConfirm() {},
        open: true,
        workspaceId: "workspace-reference-open-with-cache",
        workspaceRootGroupLabel: "Workspace"
      });
      return null;
    }

    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Harness));
    });

    const firstNode = file("opaque:first-id", "first.md");
    const secondNode = file("opaque:second-id", "second.md");
    const view = requireLatestView(latestView);

    assert.equal(view.getCachedOpenWithApplications(firstNode), null);
    assert.deepEqual(
      await view.listOpenWithApplications(firstNode),
      applications
    );
    assert.deepEqual(
      view.getCachedOpenWithApplications(secondNode),
      applications
    );
    assert.deepEqual(
      await view.listOpenWithApplications(secondNode),
      applications
    );
    assert.equal(loadCount, 1);
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.HTMLElement = previousHTMLElement;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test("reference source picker shows html source as text", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousActEnvironment = (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  let root: Root | null = null;
  try {
    const container = dom.window.document.getElementById("root");
    assert.ok(container);

    const content = "<!doctype html><h1>Hello</h1>";
    const baseAggregator = createOpenWithAggregator(async () => []);
    const aggregator: ReferenceSourceAggregator = {
      ...baseAggregator,
      getLoadedSource: () => ({
        capabilities: {
          paginated: false,
          previewable: true,
          searchable: true
        },
        isAvailable: async () => true,
        listChildren: async () => ({ entries: [], nextCursor: null }),
        metadata: {
          id: "workspace-file",
          label: "Workspace",
          order: 0
        },
        resolveSelection(node) {
          return { kind: node.kind, path: node.ref.nodeId };
        }
      }),
      readPreview: async () => ({
        bytes: new TextEncoder().encode(content),
        contentType: "text/html",
        kind: "text"
      })
    };
    let latestView: PickerView | null = null;

    function Harness() {
      latestView = useReferenceSourcePickerView({
        aggregator,
        onClose() {},
        onConfirm() {},
        open: true,
        workspaceId: "workspace-reference-html-source",
        workspaceRootGroupLabel: "Workspace"
      });
      return null;
    }

    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Harness));
    });
    const htmlNode = file("/workspace/login.html", "login.html");
    await act(async () => {
      requireLatestView(latestView).setFocusedNode(htmlNode);
      await Promise.resolve();
    });

    const previewState = requireLatestView(latestView).previewState;
    assert.equal(previewState.status, "text");
    assert.equal(
      previewState.status === "text" ? previewState.content : null,
      content
    );
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.HTMLElement = previousHTMLElement;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test("reference source picker keeps search relevance independent of browse arrangement", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousActEnvironment = (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  let root: Root | null = null;
  try {
    const container = dom.window.document.getElementById("root");
    assert.ok(container);

    const exactFile = file("/workspace/load_log", "load_log");
    const fuzzyFolder: ReferenceNode = {
      displayName: "downloaded_catalog_data",
      kind: "folder",
      ref: {
        nodeId: "/workspace/downloaded_catalog_data",
        sourceId: "workspace-file"
      }
    };
    const baseAggregator = createOpenWithAggregator(async () => []);
    const aggregator: ReferenceSourceAggregator = {
      ...baseAggregator,
      search: async () => ({
        entries: [exactFile, fuzzyFolder],
        nextCursor: null
      })
    };
    let latestView: PickerView | null = null;

    function Harness() {
      latestView = useReferenceSourcePickerView({
        aggregator,
        onClose() {},
        onConfirm() {},
        open: true,
        workspaceId: "workspace-reference-search-order",
        workspaceRootGroupLabel: "Workspace"
      });
      return null;
    }

    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Harness));
    });
    await act(async () => {
      const view = requireLatestView(latestView);
      view.setArrangeMode("name");
      view.setSearchQuery("load_log");
      await new Promise((resolve) => setTimeout(resolve, 220));
    });

    assert.deepEqual(
      requireLatestView(latestView).searchResults.map(
        (node) => node.ref.nodeId
      ),
      [exactFile.ref.nodeId, fuzzyFolder.ref.nodeId]
    );
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.HTMLElement = previousHTMLElement;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

function createOpenWithAggregator(
  listOpenWithApplications: ReferenceSourceAggregator["listOpenWithApplications"]
): ReferenceSourceAggregator {
  const tabs: ReferenceSourceTab[] = [
    {
      capabilities: {
        paginated: false,
        previewable: true,
        searchable: true
      },
      label: "Workspace",
      sourceId: "workspace-file"
    }
  ];
  return {
    getLoadedSource: () => undefined,
    listChildren: async () => ({ entries: [], nextCursor: null }),
    listOpenWithApplications,
    listRoot: async () => [],
    listSources: async () => tabs,
    locateTarget: async () => null,
    open: async () => {},
    openWithApplication: async () => {},
    openWithOtherApplication: async () => {},
    readPreview: async () => null,
    resolveSelection(node) {
      return { kind: node.kind, path: node.ref.nodeId };
    },
    reveal: async () => {},
    search: async () => ({ entries: [], nextCursor: null })
  };
}

function file(nodeId: string, displayName: string): ReferenceNode {
  return {
    displayName,
    kind: "file",
    ref: { nodeId, sourceId: "workspace-file" }
  };
}

function requireLatestView(view: PickerView | null): PickerView {
  assert.ok(view);
  return view;
}
