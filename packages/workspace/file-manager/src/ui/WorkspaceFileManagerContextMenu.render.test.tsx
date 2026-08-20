import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileManagerSession } from "../services/workspaceFileManagerService.interface.ts";
import type { WorkspaceFileEntry } from "../services/workspaceFileManagerTypes.ts";

const contextMenuView = vi.hoisted(() => ({
  contextMenu: null as {
    entry: WorkspaceFileEntry;
    x: number;
    y: number;
  } | null,
  currentDirectoryPath: "/workspace",
  isBusy: false,
  isLoading: false,
  isMutating: false
}));

vi.mock("./useWorkspaceFileManagerService.ts", () => ({
  useWorkspaceFileManagerContextMenuView: () => ({
    state: {},
    view: contextMenuView
  })
}));

import { WorkspaceFileManagerContextMenu } from "./WorkspaceFileManagerContextMenu.tsx";
import { WorkspaceFileManagerContextMenuContainer } from "./WorkspaceFileManagerContextMenuContainer.tsx";

describe("WorkspaceFileManagerContextMenu", () => {
  let container: HTMLDivElement;
  let root: Root;
  let previousActEnvironment: boolean | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document
      .querySelectorAll("[data-workspace-file-manager-context-menu]")
      .forEach((menu) => menu.remove());
    contextMenuView.contextMenu = null;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  it("activates a viewport action on pointer down before closing the menu", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <WorkspaceFileManagerContextMenu
          contextMenu={{ x: 20, y: 20 }}
          contextMenuRef={{ current: null }}
          items={[
            {
              type: "item",
              id: "open",
              label: "Open",
              onSelect
            }
          ]}
          positionMode="viewport"
          onClose={onClose}
        />
      );
    });

    const action =
      document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(action).not.toBeNull();

    await act(async () => {
      action?.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          button: 0,
          cancelable: true
        })
      );
    });

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect.mock.invocationCallOrder[0]).toBeLessThan(
      onClose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );

    await act(async () => {
      action?.click();
    });
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps viewport actions activatable without a preceding pointer event", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <WorkspaceFileManagerContextMenu
          contextMenu={{ x: 20, y: 20 }}
          contextMenuRef={{ current: null }}
          items={[
            {
              type: "item",
              id: "open",
              label: "Open",
              onSelect
            }
          ]}
          positionMode="viewport"
          onClose={onClose}
        />
      );
    });

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click();
    });

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses actions resolved for the latest right-click target", async () => {
    const firstEntry = createEntry("first");
    const secondEntry = createEntry("second");
    const selectedPaths: string[] = [];
    const closeContextMenu = vi.fn();
    const session = {
      closeContextMenu,
      store: {
        locationSections: [],
        searchQuery: "",
        selectedLocationId: null
      }
    } as unknown as WorkspaceFileManagerSession;
    const resolveContextMenu = vi.fn((request) => {
      const path =
        request.target.kind === "blank" ? null : request.target.entry.path;
      return [
        {
          type: "item" as const,
          id: "open",
          label: "Open",
          onSelect: () => {
            if (path) selectedPaths.push(path);
          }
        }
      ];
    });
    const renderMenu = () => (
      <WorkspaceFileManagerContextMenuContainer
        resolveContextMenu={resolveContextMenu}
        session={session}
      />
    );

    contextMenuView.contextMenu = { entry: firstEntry, x: 20, y: 20 };
    await act(async () => {
      root.render(renderMenu());
    });

    contextMenuView.contextMenu = { entry: secondEntry, x: 40, y: 40 };
    await act(async () => {
      root.render(renderMenu());
    });

    const action =
      document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    await act(async () => {
      action?.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          button: 0,
          cancelable: true
        })
      );
    });

    expect(resolveContextMenu).toHaveBeenCalledTimes(2);
    expect(selectedPaths).toEqual([secondEntry.path]);
    expect(closeContextMenu).toHaveBeenCalledOnce();
  });
});

function createEntry(name: string): WorkspaceFileEntry {
  return {
    hasChildren: true,
    kind: "directory",
    mtimeMs: null,
    name,
    path: `/workspace/${name}`,
    sizeBytes: null
  };
}
