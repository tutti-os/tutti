import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentHostQuickPromptSnapshot,
  AgentHostQuickPromptsApi,
  AgentHostRuntimeApi
} from "../../../../host/agentHostApi";
import type { AgentQuickPromptLabels } from "./agentQuickPromptLabels";
import { useAgentQuickPromptLibrary } from "./useAgentQuickPromptLibrary";

let hostApi: AgentHostRuntimeApi | null = null;

vi.mock("../../../../agentActivityHost", () => ({
  useOptionalAgentHostApi: () => hostApi
}));

const labels = new Proxy(
  { deleteDescription: (title: string) => title },
  {
    get: (target, property) => Reflect.get(target, property) ?? String(property)
  }
) as AgentQuickPromptLabels;

function createQuickPrompts() {
  let snapshot: AgentHostQuickPromptSnapshot = {
    enabled: true,
    status: "idle",
    prompts: [
      {
        id: "prompt-1",
        title: "Review",
        content: "Review this change",
        version: 1,
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2
      }
    ],
    error: null,
    revision: 0,
    pendingMutationIds: []
  };
  const listeners = new Set<(snapshot: AgentHostQuickPromptSnapshot) => void>();
  const api: AgentHostQuickPromptsApi = {
    ensureLoaded: vi.fn(async () => {}),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    create: vi.fn(async (input) => ({
      id: "created",
      ...input,
      version: 1,
      createdAtUnixMs: 3,
      updatedAtUnixMs: 3
    })),
    update: vi.fn(async (input) => ({
      id: input.id,
      title: input.title,
      content: input.content,
      version: input.expectedVersion + 1,
      createdAtUnixMs: 1,
      updatedAtUnixMs: 4
    })),
    remove: vi.fn(async () => {}),
    move: vi.fn(async () => snapshot.prompts)
  };
  return {
    api,
    publish(next: AgentHostQuickPromptSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener(snapshot);
    },
    snapshot: () => snapshot
  };
}

describe("useAgentQuickPromptLibrary", () => {
  beforeEach(() => {
    hostApi = null;
  });

  it("preserves canonical host order and sends an anchor move", async () => {
    const quickPrompts = createQuickPrompts();
    const older = {
      ...quickPrompts.snapshot().prompts[0]!,
      id: "older",
      title: "Older",
      updatedAtUnixMs: 1
    };
    const newer = {
      ...older,
      id: "newer",
      title: "Newer",
      updatedAtUnixMs: 99
    };
    quickPrompts.publish({
      ...quickPrompts.snapshot(),
      status: "ready",
      prompts: [older, newer],
      revision: 1
    });
    hostApi = { quickPrompts: quickPrompts.api } as AgentHostRuntimeApi;
    const rendered = renderHook(() =>
      useAgentQuickPromptLibrary({
        disabled: false,
        labels,
        onBeforeOpen: vi.fn(),
        onInsertPrompt: vi.fn()
      })
    );
    expect(
      rendered.result.current.filteredPrompts.map((prompt) => prompt.id)
    ).toEqual(["older", "newer"]);
    let moved = false;
    await act(async () => {
      moved = await rendered.result.current.reorderPrompts("older", null);
    });
    expect(moved).toBe(true);
    expect(quickPrompts.api.move).toHaveBeenCalledWith({
      promptId: "older",
      beforePromptId: null,
      expectedVersion: older.version
    });
  });

  it("locks reorder and all mutating entry points while the shared host snapshot is pending", () => {
    const quickPrompts = createQuickPrompts();
    const second = {
      ...quickPrompts.snapshot().prompts[0]!,
      id: "prompt-2",
      title: "Plan"
    };
    quickPrompts.publish({
      ...quickPrompts.snapshot(),
      status: "ready",
      prompts: [...quickPrompts.snapshot().prompts, second],
      pendingMutationIds: ["other-window-update"],
      revision: 1
    });
    hostApi = { quickPrompts: quickPrompts.api } as AgentHostRuntimeApi;
    const onInsertPrompt = vi.fn();
    const rendered = renderHook(() =>
      useAgentQuickPromptLibrary({
        disabled: false,
        labels,
        onBeforeOpen: vi.fn(),
        onInsertPrompt
      })
    );

    expect(rendered.result.current.isInteractionLocked).toBe(true);
    expect(rendered.result.current.canReorder).toBe(false);
    act(() => {
      rendered.result.current.openCreate();
      rendered.result.current.openEdit(second);
      rendered.result.current.deletePrompt(second);
      rendered.result.current.selectPrompt(second);
      rendered.result.current.setSearchQuery("plan");
    });
    expect(rendered.result.current.mode).toBe("closed");
    expect(rendered.result.current.searchQuery).toBe("");
    expect(onInsertPrompt).not.toHaveBeenCalled();
  });

  it("lazy-loads when opened and inserts a selection without a submit path", () => {
    const quickPrompts = createQuickPrompts();
    hostApi = { quickPrompts: quickPrompts.api } as AgentHostRuntimeApi;
    const onBeforeOpen = vi.fn();
    const onInsertPrompt = vi.fn();
    const rendered = renderHook(() =>
      useAgentQuickPromptLibrary({
        disabled: false,
        labels,
        onBeforeOpen,
        onInsertPrompt
      })
    );

    act(() => rendered.result.current.openPopover());
    expect(onBeforeOpen).toHaveBeenCalledOnce();
    expect(quickPrompts.api.ensureLoaded).toHaveBeenCalledWith();
    expect(rendered.result.current.isPopoverOpen).toBe(true);

    act(() =>
      rendered.result.current.selectPrompt(
        rendered.result.current.filteredPrompts[0]!
      )
    );
    expect(onInsertPrompt).toHaveBeenCalledWith("Review this change");
    expect(rendered.result.current.mode).toBe("closed");
  });

  it("inserts built-in recommendation content without persisting it", () => {
    const quickPrompts = createQuickPrompts();
    hostApi = { quickPrompts: quickPrompts.api } as AgentHostRuntimeApi;
    const onInsertPrompt = vi.fn();
    const rendered = renderHook(() =>
      useAgentQuickPromptLibrary({
        disabled: false,
        labels,
        onBeforeOpen: vi.fn(),
        onInsertPrompt
      })
    );

    act(() => rendered.result.current.openPopover());
    act(() =>
      rendered.result.current.insertPromptContent("Summarize common prompts")
    );

    expect(onInsertPrompt).toHaveBeenCalledWith("Summarize common prompts");
    expect(rendered.result.current.mode).toBe("closed");
    expect(quickPrompts.api.create).not.toHaveBeenCalled();
    expect(quickPrompts.api.update).not.toHaveBeenCalled();
  });

  it("closes all disclosure when the feature gate turns off", () => {
    const quickPrompts = createQuickPrompts();
    hostApi = { quickPrompts: quickPrompts.api } as AgentHostRuntimeApi;
    const rendered = renderHook(() =>
      useAgentQuickPromptLibrary({
        disabled: false,
        labels,
        onBeforeOpen: vi.fn(),
        onInsertPrompt: vi.fn()
      })
    );

    act(() => rendered.result.current.openPopover());
    act(() => rendered.result.current.openCreate());
    expect(rendered.result.current.isEditorOpen).toBe(true);

    act(() => {
      quickPrompts.publish({
        ...quickPrompts.snapshot(),
        enabled: false,
        revision: 1
      });
    });
    expect(rendered.result.current.capabilityAvailable).toBe(false);
    expect(rendered.result.current.mode).toBe("closed");
  });

  it("does not let a stale popover close callback dismiss the create dialog", () => {
    const quickPrompts = createQuickPrompts();
    hostApi = { quickPrompts: quickPrompts.api } as AgentHostRuntimeApi;
    const rendered = renderHook(() =>
      useAgentQuickPromptLibrary({
        disabled: false,
        labels,
        onBeforeOpen: vi.fn(),
        onInsertPrompt: vi.fn()
      })
    );

    act(() => rendered.result.current.openPopover());
    const stalePopoverOpenChange = rendered.result.current.setPopoverOpen;
    act(() => rendered.result.current.openCreate());
    expect(rendered.result.current.mode).toBe("create");

    act(() => stalePopoverOpenChange(false));
    expect(rendered.result.current.mode).toBe("create");
    expect(rendered.result.current.isEditorOpen).toBe(true);
  });

  it("does not open or load while composer controls are disabled", () => {
    const quickPrompts = createQuickPrompts();
    hostApi = { quickPrompts: quickPrompts.api } as AgentHostRuntimeApi;
    const rendered = renderHook(() =>
      useAgentQuickPromptLibrary({
        disabled: true,
        labels,
        onBeforeOpen: vi.fn(),
        onInsertPrompt: vi.fn()
      })
    );

    act(() => rendered.result.current.openPopover());
    expect(rendered.result.current.mode).toBe("closed");
    expect(quickPrompts.api.ensureLoaded).not.toHaveBeenCalled();
  });

  it("keeps a recommended template local until the user saves it", () => {
    const quickPrompts = createQuickPrompts();
    hostApi = { quickPrompts: quickPrompts.api } as AgentHostRuntimeApi;
    const rendered = renderHook(() =>
      useAgentQuickPromptLibrary({
        disabled: false,
        labels,
        onBeforeOpen: vi.fn(),
        onInsertPrompt: vi.fn()
      })
    );
    const template = {
      title: "Understand the situation",
      content: "Summarize the situation"
    };

    act(() => rendered.result.current.openCreate(template));
    expect(rendered.result.current.initialDraft).toEqual(template);
    expect(rendered.result.current.mode).toBe("create");
    expect(quickPrompts.api.create).not.toHaveBeenCalled();

    act(() => rendered.result.current.closeDialog());
    expect(rendered.result.current.initialDraft).toBeNull();
    expect(quickPrompts.api.create).not.toHaveBeenCalled();
  });

  it("runs create and preserves edit disclosure on a version conflict", async () => {
    const quickPrompts = createQuickPrompts();
    hostApi = { quickPrompts: quickPrompts.api } as AgentHostRuntimeApi;
    const rendered = renderHook(() =>
      useAgentQuickPromptLibrary({
        disabled: false,
        labels,
        onBeforeOpen: vi.fn(),
        onInsertPrompt: vi.fn()
      })
    );

    act(() => rendered.result.current.openPopover());
    act(() => rendered.result.current.openCreate());
    await act(async () => {
      expect(
        await rendered.result.current.saveDraft({
          title: "Explain",
          content: "Explain this code"
        })
      ).toBe(true);
    });
    expect(quickPrompts.api.create).toHaveBeenCalledWith({
      title: "Explain",
      content: "Explain this code"
    });
    expect(rendered.result.current.mode).toBe("popover");

    act(() =>
      rendered.result.current.openEdit(
        rendered.result.current.filteredPrompts[0]!
      )
    );
    vi.mocked(quickPrompts.api.update).mockRejectedValueOnce({
      code: "agent_quick_prompt_conflict",
      reason: "agent_quick_prompt_version_conflict",
      statusCode: 409
    });
    vi.mocked(quickPrompts.api.ensureLoaded).mockImplementationOnce(
      async () => {
        quickPrompts.publish({
          ...quickPrompts.snapshot(),
          prompts: quickPrompts.snapshot().prompts.map((prompt) => ({
            ...prompt,
            version: 2,
            updatedAtUnixMs: 5
          })),
          revision: 2
        });
      }
    );
    await act(async () => {
      expect(
        await rendered.result.current.saveDraft({
          title: "Review",
          content: "Keep my changed draft"
        })
      ).toBe(false);
    });
    expect(rendered.result.current.mode).toBe("edit");
    expect(rendered.result.current.mutationError).toBe("conflict");
    expect(quickPrompts.api.ensureLoaded).toHaveBeenLastCalledWith({
      force: true
    });
    expect(rendered.result.current.selectedPrompt?.version).toBe(2);

    await act(async () => {
      expect(
        await rendered.result.current.saveDraft({
          title: "Review",
          content: "Keep my changed draft"
        })
      ).toBe(true);
    });
    expect(quickPrompts.api.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedVersion: 2 })
    );
  });

  it("does not treat the prompt limit as a version conflict", async () => {
    const quickPrompts = createQuickPrompts();
    hostApi = { quickPrompts: quickPrompts.api } as AgentHostRuntimeApi;
    vi.mocked(quickPrompts.api.create).mockRejectedValueOnce({
      code: "agent_quick_prompt_conflict",
      reason: "agent_quick_prompt_limit_exceeded",
      statusCode: 409
    });
    const rendered = renderHook(() =>
      useAgentQuickPromptLibrary({
        disabled: false,
        labels,
        onBeforeOpen: vi.fn(),
        onInsertPrompt: vi.fn()
      })
    );

    act(() => rendered.result.current.openPopover());
    act(() => rendered.result.current.openCreate());
    await act(async () => {
      expect(
        await rendered.result.current.saveDraft({
          title: "One more prompt",
          content: "This exceeds the device limit"
        })
      ).toBe(false);
    });

    expect(rendered.result.current.mutationError).toBe("generic");
    expect(quickPrompts.api.ensureLoaded).toHaveBeenCalledTimes(1);
  });
});
