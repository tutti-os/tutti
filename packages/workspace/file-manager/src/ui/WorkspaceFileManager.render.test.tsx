import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceFileManagerI18nRuntime,
  workspaceFileManagerI18nResources
} from "../i18n/workspaceFileManagerI18n.ts";
import type { WorkspaceFileManagerSession } from "../services/workspaceFileManagerService.interface.ts";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";

const probes = vi.hoisted(() => ({
  formatWorkspaceFileBytes: vi.fn(() => "1 KB"),
  iconMap: new Map<string, string | null>(),
  onEntryIconViewportEnter: vi.fn(),
  onEntryIconViewportLeave: vi.fn(),
  setArrangeMode: vi.fn(),
  setLayoutMode: vi.fn()
}));

const fileEntries = vi.hoisted(
  () =>
    [
      {
        hasChildren: false,
        kind: "file",
        mtimeMs: null,
        name: "alpha.txt",
        path: "/workspace/alpha.txt",
        sizeBytes: 1024
      },
      {
        hasChildren: false,
        kind: "file",
        mtimeMs: null,
        name: "beta.txt",
        path: "/workspace/beta.txt",
        sizeBytes: 1024
      }
    ] satisfies WorkspaceFileEntry[]
);

const panelsState = vi.hoisted(() => ({
  busyAction: null,
  capabilities: {
    canRename: false
  },
  currentDirectoryPath: "/workspace",
  directoryExpansionByPath: {},
  entries: fileEntries,
  error: null,
  expandedDirectoryPaths: [],
  inlineRenameEntryPath: null,
  isLoading: false,
  isMutating: false,
  searchQuery: ""
}));

const panelsView = vi.hoisted(() => ({
  canMove: false,
  contextMenuEntryPath: null,
  inlineRenameEntryPath: null,
  inlineRenameValidation: null,
  isRenaming: false,
  isSearchMode: false,
  isSearching: false,
  pendingDirectoryPath: null,
  previewState: { status: "empty" },
  searchEntries: [],
  searchError: null,
  selectedEntry: null,
  selectedPath: null
}));

vi.mock("../services/workspaceFileManagerModel.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/workspaceFileManagerModel.ts")
  >()),
  formatWorkspaceFileBytes: probes.formatWorkspaceFileBytes
}));

vi.mock("./useWorkspaceFileEntryIconUrls.ts", () => ({
  useWorkspaceFileEntryIconUrls: () => ({
    iconUrlByCacheKey: probes.iconMap,
    reportEntryIconViewportEnter: probes.onEntryIconViewportEnter,
    reportEntryIconViewportLeave: probes.onEntryIconViewportLeave
  })
}));

vi.mock("./useWorkspaceFileManagerArrangeMode.ts", () => ({
  useWorkspaceFileManagerArrangeMode: () => ({
    arrangeMode: "none",
    setArrangeMode: probes.setArrangeMode
  })
}));

vi.mock("./useWorkspaceFileManagerLayoutMode.ts", () => ({
  useWorkspaceFileManagerLayoutMode: () => ({
    layoutMode: "list",
    setLayoutMode: probes.setLayoutMode
  })
}));

vi.mock("./useWorkspaceFileManagerService.ts", () => ({
  useWorkspaceFileManagerContextMenuView: () => ({
    state: panelsState,
    view: {
      contextMenu: null,
      currentDirectoryPath: "/workspace",
      isBusy: false,
      isLoading: false,
      isMutating: false
    }
  }),
  useWorkspaceFileManagerDialogsView: () => ({
    state: panelsState,
    view: {
      createDialog: null,
      deleteDialogEntry: null,
      isBusy: false,
      isDeleting: false,
      isViewing: false,
      unsupportedDialog: null
    }
  }),
  useWorkspaceFileManagerPanelsView: () => ({
    state: panelsState,
    view: panelsView
  }),
  useWorkspaceFileManagerRootView: () => ({
    isBusy: false,
    locationSections: [],
    selectedLocationId: null
  }),
  useWorkspaceFileManagerToolbarView: () => ({
    view: {
      breadcrumbs: [],
      canGoBack: false,
      canGoForward: false,
      canSearch: false,
      currentDirectoryPath: "/workspace",
      isBusy: false,
      isLoading: false,
      isMutating: false,
      isSearching: false,
      searchQuery: ""
    }
  })
}));

import { WorkspaceFileManager } from "./WorkspaceFileManager.tsx";

afterEach(() => {
  probes.formatWorkspaceFileBytes.mockClear();
  vi.restoreAllMocks();
});

describe("WorkspaceFileManager render isolation", () => {
  it("does not rerender unchanged entry rows when the real parent rerenders", async () => {
    const session = {
      openContextMenu: vi.fn(),
      store: {
        locationSections: [],
        searchQuery: "",
        selectedLocationId: null
      }
    } as unknown as WorkspaceFileManagerSession;
    const i18n = createWorkspaceFileManagerI18nRuntime(
      createI18nRuntime({
        dictionaries: [workspaceFileManagerI18nResources.en]
      })
    );
    const resolveContextMenu = vi.fn(() => []);
    const container = document.createElement("div");
    document.body.append(container);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {}
      }
    });
    const root = createRoot(container);
    const renderManager = () => (
      <WorkspaceFileManager
        i18n={i18n}
        resolveContextMenu={resolveContextMenu}
        session={session}
        showLocationSidebar={false}
        showPreviewPanel={false}
      />
    );
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(renderManager());
      });
      expect(probes.formatWorkspaceFileBytes).toHaveBeenCalledTimes(2);

      await act(async () => {
        root.render(renderManager());
      });
      expect(probes.formatWorkspaceFileBytes).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });
});
