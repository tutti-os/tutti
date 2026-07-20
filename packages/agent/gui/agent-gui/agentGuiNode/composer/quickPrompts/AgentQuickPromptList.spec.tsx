import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@tutti-os/ui-system";
import type { AgentQuickPromptLabels } from "./agentQuickPromptLabels";
import { AgentQuickPromptList } from "./AgentQuickPromptList";
import type { AgentQuickPromptLibraryController } from "./useAgentQuickPromptLibrary";

vi.mock("@tutti-os/ui-system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tutti-os/ui-system")>();
  return {
    ...actual,
    Sortable: ({
      children,
      onMove
    }: {
      children: ReactNode;
      onMove?: (event: { activeIndex: number; overIndex: number }) => void;
    }) => (
      <div>
        <button
          type="button"
          onClick={() => onMove?.({ activeIndex: 1, overIndex: 0 })}
        >
          Move second before first
        </button>
        {children}
      </div>
    ),
    SortableContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    SortableItem: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    SortableItemHandle: ({ children }: { children: ReactNode }) => children
  };
});

const prompts = [
  {
    id: "prompt-1",
    title: "Review",
    content: "Review the change",
    version: 1,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1
  },
  {
    id: "prompt-2",
    title: "Plan",
    content: "Plan the change",
    version: 1,
    createdAtUnixMs: 2,
    updatedAtUnixMs: 2
  }
];

const labels = new Proxy(
  {
    delete: "Delete",
    dragCancel: (title: string) => `Canceled ${title}`,
    dragDrop: (title: string) => `Dropped ${title}`,
    dragHandle: (title: string) => `Reorder ${title}`,
    dragInstructions: "Use the keyboard to move",
    dragMove: (title: string) => `Moving ${title}`,
    dragStart: (title: string) => `Picked up ${title}`,
    edit: "Edit"
  },
  {
    get: (target, property) => Reflect.get(target, property) ?? String(property)
  }
) as unknown as AgentQuickPromptLabels;

describe("AgentQuickPromptList", () => {
  it("restores the moved handle focus after a failed reorder", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const reorderPrompts = vi.fn(async () => false);
    const controller = {
      canReorder: true,
      filteredPrompts: prompts,
      isInteractionLocked: false,
      labels,
      reorderPrompts,
      showReorderHandles: true,
      snapshot: {
        enabled: true,
        error: null,
        pendingMutationIds: [],
        prompts,
        revision: 1,
        status: "ready"
      }
    } as unknown as AgentQuickPromptLibraryController;

    render(
      <TooltipProvider>
        <AgentQuickPromptList
          controller={controller}
          rowRefs={{ current: new Map() }}
          onDelete={vi.fn()}
          onEdit={vi.fn()}
          onFocusRow={vi.fn()}
          onSelect={vi.fn()}
        />
      </TooltipProvider>
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Move second before first" })
    );

    expect(reorderPrompts).toHaveBeenCalledWith("prompt-2", "prompt-1");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reorder Plan" })).toHaveFocus()
    );
  });
});
