import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@tutti-os/ui-system";
import type { AgentQuickPromptLabels } from "./agentQuickPromptLabels";
import { AgentQuickPromptPopover } from "./AgentQuickPromptPopover";
import type { AgentQuickPromptLibraryController } from "./useAgentQuickPromptLibrary";

const labels = new Proxy(
  {
    deleteDescription: (title: string) => `Delete ${title}`,
    dragCancel: (title: string) => `Canceled ${title}`,
    dragDrop: (title: string) => `Dropped ${title}`,
    dragHandle: (title: string) => `Reorder ${title}`,
    dragMove: (title: string) => `Moving ${title}`,
    dragStart: (title: string) => `Picked up ${title}`,
    title: "Quick prompts",
    trigger: "Prompts",
    triggerTooltip: "Choose a quick prompt",
    searchPlaceholder: "Search quick prompts",
    startSorting: "Sort",
    finishSorting: "Done",
    add: "New prompt",
    createFromTemplate: "Create from a recommended template",
    moreActions: "More prompt actions",
    edit: "Edit",
    delete: "Delete",
    empty: "No quick prompts yet",
    noResults: "No matching quick prompts",
    recommendedTemplatesTitle: "Recommended templates",
    recommendedTemplatesDescription:
      "Choose one to prefill the editor. It will not be saved or sent until you choose Save.",
    returnToPrompts: "My prompts",
    useTemplate: "Use template",
    recommendedTemplates: [
      {
        id: "understand-context",
        title: "Understand the situation",
        description: "Summarize context, constraints, risks, and next steps",
        content: "Summarize the situation"
      },
      {
        id: "create-action-plan",
        title: "Create an action plan",
        description: "Break a goal into prioritized, verifiable steps",
        content: "Create an action plan"
      },
      {
        id: "review-and-improve",
        title: "Review and improve",
        description: "Find gaps, risks, and practical improvements",
        content: "Review and improve"
      },
      {
        id: "draft-clear-update",
        title: "Draft a clear update",
        description: "Write a concise explanation for the intended audience",
        content: "Draft an update"
      }
    ]
  },
  {
    get: (target, property) => Reflect.get(target, property) ?? String(property)
  }
) as unknown as AgentQuickPromptLabels;

function controller(
  patch: Partial<AgentQuickPromptLibraryController> = {}
): AgentQuickPromptLibraryController {
  const prompt = {
    id: "prompt-1",
    title: "Review",
    content: "Review the current change",
    version: 1,
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2
  };
  return {
    capabilityAvailable: true,
    canReorder: false,
    close: vi.fn(),
    closeDialog: vi.fn(),
    deletePrompt: vi.fn(),
    filteredPrompts: [prompt],
    isDeleting: false,
    isEditorOpen: false,
    isPopoverOpen: true,
    isSaving: false,
    isInteractionLocked: false,
    isReordering: false,
    initialDraft: null,
    labels,
    mode: "popover",
    mutationError: null,
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    openPopover: vi.fn(),
    promptToDelete: null,
    retry: vi.fn(),
    reorderError: null,
    reorderPrompts: vi.fn(async () => true),
    saveDraft: vi.fn(async () => true),
    searchQuery: "",
    showReorderHandles: false,
    selectPrompt: vi.fn(),
    selectedPrompt: null,
    setPopoverOpen: vi.fn(),
    setSearchQuery: vi.fn(),
    snapshot: {
      enabled: true,
      status: "ready",
      prompts: [prompt],
      error: null,
      revision: 1,
      pendingMutationIds: []
    },
    submitDelete: vi.fn(async () => true),
    ...patch
  };
}

describe("AgentQuickPromptPopover", () => {
  it("uses the fixed-height Popover and makes only the list a ScrollArea", () => {
    render(
      <TooltipProvider>
        <AgentQuickPromptPopover controller={controller()} disabled={false} />
      </TooltipProvider>
    );

    const surface = document.querySelector('[data-slot="popover-content"]');
    expect(surface).toHaveClass("h-[420px]", "w-[400px]", "overflow-hidden");
    expect(
      screen.getByRole("dialog", { name: "Quick prompts" })
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-quick-prompt-scroll-viewport")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Review/u })
    ).toBeInTheDocument();
  });

  it("keeps selection and direct icon management controls as sibling buttons", () => {
    const subject = controller();
    render(
      <TooltipProvider>
        <AgentQuickPromptPopover controller={subject} disabled={false} />
      </TooltipProvider>
    );
    const selection = screen.getByRole("button", { name: /^Review/u });
    expect(selection.querySelector("button")).toBeNull();
    const edit = screen.getByRole("button", { name: "Edit" });
    const remove = screen.getByRole("button", { name: "Delete" });
    expect(edit).toBeInTheDocument();
    expect(remove).toBeInTheDocument();
    fireEvent.pointerDown(edit, { button: 0 });
    expect(subject.openEdit).toHaveBeenCalledOnce();
    fireEvent.pointerDown(remove, { button: 0 });
    expect(subject.deletePrompt).toHaveBeenCalledOnce();
  });

  it("shows reorder handles only in explicit sorting mode", () => {
    const first = controller().filteredPrompts[0]!;
    const second = {
      ...first,
      id: "prompt-2",
      title: "Plan",
      content: "Plan the current change"
    };
    const subject = controller({
      canReorder: true,
      filteredPrompts: [first, second],
      showReorderHandles: true,
      snapshot: {
        enabled: true,
        status: "ready",
        prompts: [first, second],
        error: null,
        revision: 1,
        pendingMutationIds: []
      }
    });
    const rendered = render(
      <TooltipProvider>
        <AgentQuickPromptPopover controller={subject} disabled={false} />
      </TooltipProvider>
    );

    expect(screen.queryByRole("button", { name: "Reorder Review" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));

    expect(
      screen.getByRole("button", { name: "Reorder Review" })
    ).toBeEnabled();
    expect(screen.getByPlaceholderText("Search quick prompts")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Create from a recommended template"
      })
    ).toBeNull();

    rendered.rerender(
      <TooltipProvider>
        <AgentQuickPromptPopover
          controller={controller({
            canReorder: false,
            filteredPrompts: [first, second],
            isInteractionLocked: true,
            showReorderHandles: true,
            snapshot: {
              enabled: true,
              status: "ready",
              prompts: [first, second],
              error: null,
              revision: 2,
              orderMutationPending: true,
              pendingMutationIds: [first.id]
            }
          })}
          disabled={false}
        />
      </TooltipProvider>
    );

    expect(
      screen.getByRole("button", { name: "Reorder Review" })
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Review/u })).toBeNull();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  });

  it("uses standard click semantics to enter and finish sorting", () => {
    const first = controller().filteredPrompts[0]!;
    const second = { ...first, id: "prompt-2", title: "Plan" };
    render(
      <TooltipProvider>
        <AgentQuickPromptPopover
          controller={controller({
            canReorder: true,
            filteredPrompts: [first, second],
            showReorderHandles: true,
            snapshot: {
              enabled: true,
              status: "ready",
              prompts: [first, second],
              error: null,
              revision: 1,
              pendingMutationIds: []
            }
          })}
          disabled={false}
        />
      </TooltipProvider>
    );

    const sort = screen.getByRole("button", { name: "Sort" });
    fireEvent.pointerDown(sort, { button: 0 });
    expect(screen.getByRole("button", { name: "Sort" })).toBeInTheDocument();
    fireEvent.click(sort);
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();

    const done = screen.getByRole("button", { name: "Done" });
    fireEvent.pointerDown(done, { button: 0 });
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    fireEvent.click(done);
    expect(screen.getByRole("button", { name: "Sort" })).toBeInTheDocument();
  });

  it("resets sorting mode when the controlled Popover closes externally", () => {
    const first = controller().filteredPrompts[0]!;
    const second = { ...first, id: "prompt-2", title: "Plan" };
    const openController = controller({
      canReorder: true,
      filteredPrompts: [first, second],
      showReorderHandles: true,
      snapshot: {
        enabled: true,
        status: "ready",
        prompts: [first, second],
        error: null,
        revision: 1,
        pendingMutationIds: []
      }
    });
    const rendered = render(
      <TooltipProvider>
        <AgentQuickPromptPopover controller={openController} disabled={false} />
      </TooltipProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();

    rendered.rerender(
      <TooltipProvider>
        <AgentQuickPromptPopover
          controller={{ ...openController, isPopoverOpen: false }}
          disabled={false}
        />
      </TooltipProvider>
    );
    rendered.rerender(
      <TooltipProvider>
        <AgentQuickPromptPopover controller={openController} disabled={false} />
      </TooltipProvider>
    );

    expect(screen.getByRole("button", { name: "Sort" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reorder Review" })).toBeNull();
  });

  it("does not allow sorting a filtered list", () => {
    render(
      <TooltipProvider>
        <AgentQuickPromptPopover
          controller={controller({
            searchQuery: "review",
            showReorderHandles: false
          })}
          disabled={false}
        />
      </TooltipProvider>
    );

    expect(screen.getByRole("button", { name: "Sort" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Reorder Review" })).toBeNull();
  });

  it("disables every mutating entry point while a shared mutation is pending", () => {
    render(
      <TooltipProvider>
        <AgentQuickPromptPopover
          controller={controller({
            canReorder: false,
            isInteractionLocked: true,
            showReorderHandles: true
          })}
          disabled={false}
        />
      </TooltipProvider>
    );

    expect(screen.getByRole("button", { name: "New prompt" })).toBeDisabled();
    expect(screen.getByPlaceholderText("Search quick prompts")).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Review/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sort" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Reorder Review" })).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Create from a recommended template"
      })
    ).toBeDisabled();
  });

  it("selects a prompt on primary pointer down before the Popover closes", () => {
    const subject = controller();
    render(
      <TooltipProvider>
        <AgentQuickPromptPopover controller={subject} disabled={false} />
      </TooltipProvider>
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Review/u }), {
      button: 0
    });
    expect(subject.selectPrompt).toHaveBeenCalledOnce();
  });

  it("starts creation on primary pointer down so the Dialog survives Popover dismissal", () => {
    const subject = controller();
    render(
      <TooltipProvider>
        <AgentQuickPromptPopover controller={subject} disabled={false} />
      </TooltipProvider>
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "New prompt" }), {
      button: 0
    });
    expect(subject.openCreate).toHaveBeenCalledOnce();
  });

  it("shows recommended templates for an empty library and prefills the editor only", () => {
    const subject = controller({
      filteredPrompts: [],
      snapshot: {
        enabled: true,
        status: "ready",
        prompts: [],
        error: null,
        revision: 1,
        pendingMutationIds: []
      }
    });
    render(
      <TooltipProvider>
        <AgentQuickPromptPopover controller={subject} disabled={false} />
      </TooltipProvider>
    );

    const template = screen.getByRole("button", {
      name: /Understand the situation.*Use template/u
    });
    fireEvent.pointerDown(template, { button: 0 });
    expect(subject.openCreate).toHaveBeenCalledWith({
      title: "Understand the situation",
      content: "Summarize the situation"
    });
  });

  it("lets a non-empty library reopen recommended templates in the same Popover", () => {
    render(
      <TooltipProvider>
        <AgentQuickPromptPopover controller={controller()} disabled={false} />
      </TooltipProvider>
    );

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Create from a recommended template"
      }),
      { button: 0 }
    );
    expect(
      screen.getByRole("heading", { name: "Recommended templates", level: 2 })
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search quick prompts")).toBeNull();
    expect(
      screen.getByRole("button", { name: "My prompts" })
    ).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "My prompts" }), {
      button: 0
    });
    expect(
      screen.getByRole("heading", { name: "Quick prompts", level: 2 })
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Search quick prompts")
    ).toBeInTheDocument();
  });

  it("hides the complete entry when the host gate is unavailable", () => {
    const rendered = render(
      <TooltipProvider>
        <AgentQuickPromptPopover
          controller={controller({ capabilityAvailable: false })}
          disabled={false}
        />
      </TooltipProvider>
    );
    expect(rendered.container).toBeEmptyDOMElement();
  });

  it("opens system dialogs for create and destructive confirmation", () => {
    const createRender = render(
      <TooltipProvider>
        <AgentQuickPromptPopover
          controller={controller({
            isEditorOpen: true,
            isPopoverOpen: false,
            mode: "create"
          })}
          disabled={false}
        />
      </TooltipProvider>
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(labels.titleLabel)).toBeInTheDocument();
    createRender.unmount();

    const promptToDelete = controller().filteredPrompts[0]!;
    render(
      <TooltipProvider>
        <AgentQuickPromptPopover
          controller={controller({
            isPopoverOpen: false,
            mode: "delete",
            promptToDelete
          })}
          disabled={false}
        />
      </TooltipProvider>
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      labels.deleteDescription(promptToDelete.title)
    );
    expect(
      screen.getByRole("button", { name: labels.deleteConfirm })
    ).toBeInTheDocument();
  });

  it("runs dialog cancellation and deletion on primary pointer down", () => {
    const createSubject = controller({
      isEditorOpen: true,
      isPopoverOpen: false,
      mode: "create"
    });
    const createRender = render(
      <TooltipProvider>
        <AgentQuickPromptPopover controller={createSubject} disabled={false} />
      </TooltipProvider>
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: labels.cancel }), {
      button: 0
    });
    expect(createSubject.closeDialog).toHaveBeenCalledOnce();
    createRender.unmount();

    const deleteSubject = controller({
      isPopoverOpen: false,
      mode: "delete",
      promptToDelete: controller().filteredPrompts[0]!
    });
    render(
      <TooltipProvider>
        <AgentQuickPromptPopover controller={deleteSubject} disabled={false} />
      </TooltipProvider>
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: labels.deleteConfirm }),
      { button: 0 }
    );
    expect(deleteSubject.submitDelete).toHaveBeenCalledOnce();
  });

  it("preserves an edited draft when a conflict refreshes the same prompt", () => {
    const prompt = controller().filteredPrompts[0]!;
    const rendered = render(
      <TooltipProvider>
        <AgentQuickPromptPopover
          controller={controller({
            isEditorOpen: true,
            isPopoverOpen: false,
            mode: "edit",
            selectedPrompt: prompt
          })}
          disabled={false}
        />
      </TooltipProvider>
    );
    const content = screen.getByLabelText(labels.contentLabel);
    fireEvent.change(content, { target: { value: "My unsaved draft" } });

    rendered.rerender(
      <TooltipProvider>
        <AgentQuickPromptPopover
          controller={controller({
            isEditorOpen: true,
            isPopoverOpen: false,
            mode: "edit",
            selectedPrompt: { ...prompt, version: 2, updatedAtUnixMs: 5 }
          })}
          disabled={false}
        />
      </TooltipProvider>
    );
    expect(screen.getByLabelText(labels.contentLabel)).toHaveValue(
      "My unsaved draft"
    );
  });

  it("prefills the existing editor Dialog from a recommended template draft", () => {
    render(
      <TooltipProvider>
        <AgentQuickPromptPopover
          controller={controller({
            initialDraft: {
              title: "Understand the situation",
              content: "Summarize the situation"
            },
            isEditorOpen: true,
            isPopoverOpen: false,
            mode: "create"
          })}
          disabled={false}
        />
      </TooltipProvider>
    );

    expect(screen.getByLabelText(labels.titleLabel)).toHaveValue(
      "Understand the situation"
    );
    expect(screen.getByLabelText(labels.contentLabel)).toHaveValue(
      "Summarize the situation"
    );
  });

  it("keeps Enter in the editor Dialog out of the Composer shortcut", () => {
    const onComposerKeyDown = vi.fn();
    render(
      <div onKeyDown={onComposerKeyDown}>
        <TooltipProvider>
          <AgentQuickPromptPopover
            controller={controller({
              isEditorOpen: true,
              isPopoverOpen: false,
              mode: "create"
            })}
            disabled={false}
          />
        </TooltipProvider>
      </div>
    );

    fireEvent.keyDown(screen.getByLabelText(labels.titleLabel), {
      key: "Enter"
    });
    expect(onComposerKeyDown).not.toHaveBeenCalled();
  });
});

describe("quick-prompt UI composition", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "agent-gui/agentGuiNode/composer/quickPrompts/AgentQuickPromptPopover.tsx"
    ),
    "utf8"
  );
  const editorSource = readFileSync(
    join(
      process.cwd(),
      "agent-gui/agentGuiNode/composer/quickPrompts/AgentQuickPromptEditorDialog.tsx"
    ),
    "utf8"
  );
  const listSource = readFileSync(
    join(
      process.cwd(),
      "agent-gui/agentGuiNode/composer/quickPrompts/AgentQuickPromptList.tsx"
    ),
    "utf8"
  );
  const rowSource = readFileSync(
    join(
      process.cwd(),
      "agent-gui/agentGuiNode/composer/quickPrompts/AgentQuickPromptRow.tsx"
    ),
    "utf8"
  );

  it("composes only public UI System interaction primitives", () => {
    expect(source).toContain('from "@tutti-os/ui-system"');
    expect(source).toContain('from "@tutti-os/ui-system/icons"');
    expect(source).toContain("<ScrollArea");
    expect(source).toContain("<TooltipProvider");
    expect(source).toMatch(
      /<TooltipTrigger asChild>\s*<span[^>]*>\s*<PopoverTrigger asChild>/u
    );
    expect(source).toContain("<ConfirmationDialog");
    expect(source).toContain("<RecommendedTemplateList");
    expect(rowSource).toContain("aria-label={labels.edit}");
    expect(rowSource).toContain("aria-label={labels.delete}");
    expect(rowSource).toContain("group/quick-prompt-row");
    expect(rowSource).not.toContain("group-focus-within");
    expect(rowSource).toContain(
      'className="cursor-grab text-[var(--text-tertiary)]'
    );
    expect(rowSource).toContain(
      "disabled:cursor-not-allowed disabled:text-[var(--text-disabled)] disabled:opacity-100"
    );
    expect(rowSource).toContain('reorderDisabled ? "cursor-not-allowed" : ""');
    expect(rowSource).not.toContain("className={revealClass}");
    expect(listSource).toContain("<Sortable");
    expect(listSource).toContain("<SortableItem");
    expect(listSource).not.toContain("disabled={!isSorting");
    expect(rowSource).toContain("<SortableItemHandle");
    expect(source).not.toContain("<DropdownMenu");
    expect(source).toContain("onCloseAutoFocus");
    expect(editorSource).toContain("<Dialog");
    expect(editorSource).toContain("<Textarea");
    expect(editorSource).toContain("min-h-[128px]");
    expect(editorSource).toContain("onKeyDownCapture");
    expect(source).not.toMatch(/<button\b/u);
    expect(editorSource).not.toMatch(/<button\b/u);
    expect(rowSource).not.toMatch(/<button\b/u);
    expect(source).not.toContain("radix-ui");
    expect(editorSource).not.toContain("radix-ui");
  });
});
