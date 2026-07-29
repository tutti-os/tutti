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
import { SOURCE_ROOT_NODE_ID } from "../../../core/referenceSourceAggregator.ts";
import { nodeRefKey } from "../../../core/referenceSourceUtils.ts";
import { useReferenceSourcePickerView } from "./useReferenceSourcePickerView.ts";

type PickerView = ReturnType<typeof useReferenceSourcePickerView>;
type JsdomModule = {
  JSDOM: new (html: string) => {
    window: Window & typeof globalThis;
  };
};

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as JsdomModule;

test("reference source picker keeps confirming until selection preparation completes", async () => {
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
    let resolvePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      resolvePreparation = resolve;
    });
    let preparationCount = 0;
    const baseAggregator = createOpenWithAggregator(async () => []);
    const aggregator: ReferenceSourceAggregator = {
      ...baseAggregator,
      async prepareSelection(_scope, node) {
        preparationCount += 1;
        await preparation;
        return {
          kind: node.kind,
          path: "/var/cache/tsh/local-assets/workspace/photo.png",
          sourceId: node.ref.sourceId
        };
      }
    };
    let closeCount = 0;
    let confirmedPaths: string[] = [];
    let latestView: PickerView | null = null;

    function Harness() {
      latestView = useReferenceSourcePickerView({
        aggregator,
        onClose() {
          closeCount += 1;
        },
        onConfirm(references) {
          confirmedPaths = references.map((reference) => reference.path);
        },
        open: true,
        workspaceId: "workspace-reference-confirm-preparation"
      });
      return null;
    }

    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Harness));
      await flushEffects();
    });
    const selected = file("opaque-host-handle", "photo.png");
    await act(async () => {
      requireLatestView(latestView).toggleSelection(selected);
    });

    let confirmation!: Promise<void>;
    let duplicateConfirmation!: Promise<void>;
    await act(async () => {
      confirmation = requireLatestView(latestView).confirm();
      duplicateConfirmation = requireLatestView(latestView).confirm();
      await Promise.resolve();
    });
    assert.equal(requireLatestView(latestView).isConfirming, true);
    assert.equal(preparationCount, 1);
    assert.equal(closeCount, 0);
    assert.deepEqual(confirmedPaths, []);

    await act(async () => {
      resolvePreparation();
      await Promise.all([confirmation, duplicateConfirmation]);
    });
    assert.equal(requireLatestView(latestView).isConfirming, false);
    assert.equal(closeCount, 1);
    assert.deepEqual(confirmedPaths, [
      "/var/cache/tsh/local-assets/workspace/photo.png"
    ]);
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

test("reference source picker keeps the dialog open after preparation failure", async () => {
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
    const baseAggregator = createOpenWithAggregator(async () => []);
    const aggregator: ReferenceSourceAggregator = {
      ...baseAggregator,
      async prepareSelection() {
        throw new Error("selection preparation failed");
      }
    };
    let closeCount = 0;
    let confirmCount = 0;
    let latestView: PickerView | null = null;

    function Harness() {
      latestView = useReferenceSourcePickerView({
        aggregator,
        onClose() {
          closeCount += 1;
        },
        onConfirm() {
          confirmCount += 1;
        },
        open: true,
        workspaceId: "workspace-reference-confirm-error"
      });
      return null;
    }

    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Harness));
      await flushEffects();
    });
    await act(async () => {
      requireLatestView(latestView).toggleSelection(
        file("opaque-host-handle", "photo.png")
      );
    });
    await act(async () => {
      await requireLatestView(latestView).confirm();
    });

    const view = requireLatestView(latestView);
    assert.equal(view.isConfirming, false);
    assert.equal(view.confirmError?.message, "selection preparation failed");
    assert.equal(closeCount, 0);
    assert.equal(confirmCount, 0);
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
        workspaceId: "workspace-reference-open-with-cache"
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
        workspaceId: "workspace-reference-html-source"
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

test("single-selection picker uses the source heading as root and selects sidebar directories", async () => {
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

    const project = folder("/workspace/proj-1", "proj-1");
    const documentsOnlyProject = folder("/workspace/proj-docs", "proj-docs");
    const notes = file("/workspace/notes.md", "notes.md");
    const photo = file("/workspace/photo.png", "photo.png");
    const nestedPhoto = file("/workspace/proj-1/nested.png", "nested.png");
    const aggregator = createSidebarAggregator(
      [project, documentsOnlyProject, notes, photo],
      {
        [project.ref.nodeId]: [nestedPhoto],
        [documentsOnlyProject.ref.nodeId]: [
          file("/workspace/proj-docs/readme.md", "readme.md")
        ]
      }
    );
    aggregator.locateTarget = async (_scope, _sourceId, params) =>
      params.path === documentsOnlyProject.ref.nodeId
        ? [documentsOnlyProject.ref]
        : null;
    let latestView: PickerView | null = null;

    function Harness() {
      latestView = useReferenceSourcePickerView({
        aggregator,
        onClose() {},
        onConfirm() {},
        open: true,
        selectionMode: "single",
        workspaceId: "workspace-reference-root-group"
      });
      return null;
    }

    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Harness));
      await flushEffects();
    });

    let view = requireLatestView(latestView);
    assert.deepEqual(
      view.sidebarGroups.map((group) => group.displayName),
      ["proj-1", "proj-docs"]
    );
    assert.equal(view.selectedGroupKey, null);
    assert.equal(view.selectionCount, 0);
    assert.deepEqual(
      view.currentEntries.map((entry) => entry.displayName),
      ["proj-1", "proj-docs", "notes.md", "photo.png"]
    );

    await act(async () => {
      view.setFilters(["image"]);
    });
    await waitFor(() => {
      const current = requireLatestView(latestView);
      return (
        !current.isLoading &&
        current.currentEntries.every(
          (entry) => entry.displayName !== "proj-docs"
        )
      );
    });
    view = requireLatestView(latestView);
    assert.equal(view.isQuery, false);
    assert.deepEqual(
      view.currentEntries.map((entry) => entry.displayName),
      ["proj-1", "photo.png"]
    );
    assert.deepEqual(
      view.childrenByKey[nodeRefKey(project.ref)]?.entries.map(
        (entry) => entry.displayName
      ),
      ["nested.png"]
    );

    await act(async () => {
      view.selectGroup(project);
      await flushEffects();
    });
    view = requireLatestView(latestView);
    assert.equal(view.currentNode?.displayName, "proj-1");
    assert.equal(view.selectionCount, 1);
    assert.deepEqual(view.selection, [project]);

    await act(async () => {
      view.selectSourceRoot("workspace-file");
      await flushEffects();
    });
    view = requireLatestView(latestView);
    assert.equal(view.currentNode, null);
    assert.equal(view.selectedGroupKey, null);
    assert.deepEqual(
      view.currentEntries.map((entry) => entry.displayName),
      ["proj-1", "photo.png"]
    );

    let selectedUploadedDirectory = false;
    await act(async () => {
      selectedUploadedDirectory = await view.selectTarget({
        sourceId: "workspace-file",
        params: { path: documentsOnlyProject.ref.nodeId }
      });
    });
    view = requireLatestView(latestView);
    assert.equal(selectedUploadedDirectory, true);
    assert.deepEqual(view.selection, [documentsOnlyProject]);
    assert.deepEqual(view.activeFilters, []);
    assert.equal(view.currentNode, documentsOnlyProject);
    assert.equal(view.selectedGroupKey, nodeRefKey(documentsOnlyProject.ref));
    assert.equal(view.focusedNode, null);
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
    async prepareSelection(_scope, node) {
      return { kind: node.kind, path: node.ref.nodeId };
    },
    reveal: async () => {},
    search: async () => ({ entries: [], nextCursor: null })
  };
}

function createSidebarAggregator(
  rootEntries: ReferenceNode[],
  entriesByNodeId: Record<string, ReferenceNode[]> = {}
): ReferenceSourceAggregator {
  const tabs: ReferenceSourceTab[] = [
    {
      capabilities: {
        navigable: false,
        paginated: false,
        previewable: false,
        searchable: true
      },
      label: "Workspace",
      sourceId: "workspace-file"
    }
  ];
  return {
    getLoadedSource: () => undefined,
    listChildren: async (_scope, node) => ({
      entries:
        node.nodeId === SOURCE_ROOT_NODE_ID
          ? rootEntries
          : (entriesByNodeId[node.nodeId] ?? []),
      nextCursor: null
    }),
    listOpenWithApplications: async () => [],
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
    async prepareSelection(_scope, node) {
      return { kind: node.kind, path: node.ref.nodeId };
    },
    reveal: async () => {},
    search: async () => ({ entries: [], nextCursor: null })
  };
}

function folder(nodeId: string, displayName: string): ReferenceNode {
  return {
    displayName,
    kind: "folder",
    ref: { nodeId, sourceId: "workspace-file" }
  };
}

async function flushEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await flushEffects();
    });
  }
  assert.fail("timed out waiting for picker state");
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
