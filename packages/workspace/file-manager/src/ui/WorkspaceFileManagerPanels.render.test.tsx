import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceFileManagerI18nRuntime,
  workspaceFileManagerI18nResources
} from "../i18n/workspaceFileManagerI18n.ts";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";
import { WorkspaceFileManagerPanels } from "./WorkspaceFileManagerPanels.tsx";

describe("WorkspaceFileManagerPanels", () => {
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
      expect(rowButton).not.toBeNull();
      expect(disclosureButton).not.toBeNull();

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
