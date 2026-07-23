import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceFileManagerI18nRuntime,
  workspaceFileManagerI18nResources
} from "../i18n/workspaceFileManagerI18n.ts";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";
import {
  WorkspaceArchiveFallbackIcon,
  WorkspaceFolderFallbackIcon
} from "./WorkspaceFileEntryIcon.tsx";
import { WorkspaceFileManagerPanels } from "./WorkspaceFileManagerPanels.tsx";

describe("WorkspaceFileManagerPanels", () => {
  it.each([
    ["archive", WorkspaceArchiveFallbackIcon],
    ["folder", WorkspaceFolderFallbackIcon]
  ] as const)(
    "renders the %s fallback as a code-owned SVG without an image request",
    async (_kind, FallbackIcon) => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const previousActEnvironment = (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT;
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;

      try {
        await act(async () => {
          root.render(<FallbackIcon className="size-4" />);
        });

        expect(container.querySelector("svg")).not.toBeNull();
        expect(container.querySelector("img")).toBeNull();
      } finally {
        await act(async () => {
          root.unmount();
        });
        container.remove();
        (
          globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
        ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    }
  );

  it("keeps row activation and directory disclosure as sibling buttons", async () => {
    const entry: WorkspaceFileEntry = {
      hasChildren: true,
      kind: "directory",
      mtimeMs: null,
      name: "Applications",
      path: "/Users/demo/Applications",
      sizeBytes: null
    };
    const onSelect = vi.fn();
    const onEntryDragStart = vi.fn();
    const onToggleDirectoryExpanded = vi.fn();
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
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <WorkspaceFileManagerPanels
            arrangeMode="none"
            canMove={false}
            contextMenuEntryPath={null}
            copy={createWorkspaceFileManagerI18nRuntime(
              createI18nRuntime({
                dictionaries: [workspaceFileManagerI18nResources.en]
              })
            )}
            inlineRenameEntryPath={null}
            inlineRenameValidation={null}
            isRenaming={false}
            layoutMode="list"
            pendingDirectoryPath={null}
            previewState={{ status: "empty" }}
            selectedEntry={null}
            selectedPath={null}
            showPreviewPanel={false}
            state={{
              entries: [entry],
              error: null,
              isLoading: false,
              isSearchMode: false
            }}
            treeRows={[
              {
                depth: 0,
                entry,
                expanded: false,
                expandable: true,
                kind: "entry",
                loadingChildren: false
              }
            ]}
            onBlankContextMenu={() => {}}
            onCancelInlineRename={() => {}}
            onClearInlineRenameValidation={() => {}}
            onConfirmInlineRename={async () => true}
            onEntryContextMenu={() => {}}
            onEntryDragStart={onEntryDragStart}
            onMoveEntry={() => {}}
            onOpenEntry={() => {}}
            onSelect={onSelect}
            onToggleDirectoryExpanded={onToggleDirectoryExpanded}
          />
        );
      });

      const row = container.querySelector<HTMLElement>(
        '[data-workspace-file-entry-path="/Users/demo/Applications"]'
      );
      const rowButton = row?.querySelector<HTMLButtonElement>(
        'button[aria-label="Applications"]'
      );
      const disclosureButton = row?.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand folder"]'
      );

      expect(row).not.toBeNull();
      expect(row?.querySelector("button button")).toBeNull();
      expect(row?.draggable).toBe(true);
      expect(rowButton).not.toBeNull();
      expect(rowButton?.draggable).toBe(false);
      expect(disclosureButton).not.toBeNull();

      const dataTransfer = {} as DataTransfer;
      const dragStartEvent = new Event("dragstart", {
        bubbles: true,
        cancelable: true
      });
      Object.defineProperty(dragStartEvent, "dataTransfer", {
        value: dataTransfer
      });
      await act(async () => {
        row?.dispatchEvent(dragStartEvent);
      });
      expect(onEntryDragStart).toHaveBeenCalledWith(entry, dataTransfer);

      await act(async () => {
        rowButton?.click();
      });
      expect(onSelect).toHaveBeenCalledOnce();

      await act(async () => {
        disclosureButton?.click();
      });
      expect(onToggleDirectoryExpanded).toHaveBeenCalledWith(entry, false);
      expect(onSelect).toHaveBeenCalledOnce();
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
