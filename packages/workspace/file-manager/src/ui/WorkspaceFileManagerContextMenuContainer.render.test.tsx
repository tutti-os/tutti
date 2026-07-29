import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileManagerSession } from "../services/workspaceFileManagerService.interface.ts";

const probes = vi.hoisted(() => ({
  contextMenu: {
    entry: {
      hasChildren: false,
      kind: "file" as const,
      mtimeMs: null,
      name: "alpha.txt",
      path: "/workspace/alpha.txt",
      sizeBytes: 1024
    },
    x: 120,
    y: 80
  }
}));

vi.mock("./useWorkspaceFileManagerService.ts", () => ({
  useWorkspaceFileManagerContextMenuView: () => ({
    view: {
      contextMenu: probes.contextMenu,
      currentDirectoryPath: "/workspace",
      isBusy: false,
      isLoading: false,
      isMutating: false
    }
  })
}));

import { WorkspaceFileManagerContextMenuContainer } from "./WorkspaceFileManagerContextMenuContainer.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("WorkspaceFileManagerContextMenuContainer", () => {
  it("portals an actionable menu outside a contained Agent sidebar", async () => {
    const closeContextMenu = vi.fn();
    const onSelect = vi.fn();
    const resolveContextMenu = vi.fn(() => [
      {
        id: "open",
        label: "Open",
        onSelect,
        type: "item" as const
      }
    ]);
    const session = {
      closeContextMenu,
      store: {
        locationSections: [],
        searchQuery: "",
        selectedLocationId: null
      }
    } as unknown as WorkspaceFileManagerSession;
    const sidebar = document.createElement("aside");
    sidebar.style.contain = "layout paint";
    sidebar.style.overflow = "hidden";
    document.body.append(sidebar);
    const root = createRoot(sidebar);
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <WorkspaceFileManagerContextMenuContainer
            resolveContextMenu={resolveContextMenu}
            session={session}
          />
        );
      });

      const menu = document.querySelector<HTMLElement>(
        "[data-workspace-file-manager-context-menu]"
      );
      expect(menu).not.toBeNull();
      expect(sidebar.contains(menu)).toBe(false);
      expect(menu?.classList.contains("fixed")).toBe(true);
      expect(menu?.style.zIndex).toBe("var(--z-panel-popover)");

      const openButton =
        menu?.querySelector<HTMLButtonElement>('[role="menuitem"]');
      expect(openButton?.textContent).toContain("Open");

      await act(async () => {
        openButton?.click();
      });
      expect(closeContextMenu).toHaveBeenCalledOnce();
      expect(onSelect).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        root.unmount();
      });
      sidebar.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });
});
