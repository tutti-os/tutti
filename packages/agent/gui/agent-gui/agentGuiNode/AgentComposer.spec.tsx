import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import {
  createWorkspaceUserProjectI18nRuntime,
  workspaceUserProjectI18nResources
} from "@tutti-os/workspace-user-project/i18n";
import { AgentComposer } from "./AgentComposer";
import type {
  AgentComposerDraft,
  AgentGUIComposerSettingsVM,
  AgentGUIQueuedPromptVM
} from "./model/agentGuiNodeTypes";
import type { AgentHostAgentSessionCommand } from "../../shared/contracts/dto";

const { mockProjectMissingState } = vi.hoisted(() => ({
  mockProjectMissingState: {
    current: false
  }
}));

afterEach(() => {
  mockProjectMissingState.current = false;
});

const workspaceUserProjectI18n = createWorkspaceUserProjectI18nRuntime(
  createI18nRuntime({
    dictionaries: [workspaceUserProjectI18nResources["zh-CN"]]
  })
);

function createDraft(
  prompt: string,
  images: AgentComposerDraft["images"] = []
): AgentComposerDraft {
  return { prompt, images };
}

function createImageDataTransfer(file: File): DataTransfer {
  return {
    effectAllowed: "copy",
    dropEffect: "none",
    types: ["Files"],
    files: [file],
    items: [
      {
        kind: "file",
        type: file.type,
        getAsFile: () => file
      }
    ]
  } as unknown as DataTransfer;
}

vi.mock("../../app/renderer/components/ui/popover", () => ({
  Popover: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverAnchor: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverContent: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  )
}));

vi.mock("./agentRichText/AgentRichTextEditor", () => ({
  AgentRichTextEditor: ({
    disabled,
    onPasteImages,
    value,
    placeholder
  }: {
    disabled?: boolean;
    onPasteImages?: (images: unknown[]) => void;
    value: string;
    placeholder: string;
  }) => (
    <>
      <textarea
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        readOnly
      />
      <button
        type="button"
        data-testid="mock-paste-image"
        onClick={() =>
          onPasteImages?.([
            {
              name: "screen.png",
              mimeType: "image/png",
              data: "aW1hZ2U="
            }
          ])
        }
      >
        paste image
      </button>
    </>
  )
}));

vi.mock("./AgentComposerSettingsMenus", () => ({
  AgentProjectDropdown: ({
    onProjectMissingChange
  }: {
    onProjectMissingChange?: (isMissing: boolean) => void;
  }) => {
    queueMicrotask(() => {
      onProjectMissingChange?.(mockProjectMissingState.current);
    });
    return (
      <button type="button" data-testid="agent-project-dropdown">
        项目
      </button>
    );
  },
  AgentProjectMissingStatusProbe: ({
    onProjectMissingChange
  }: {
    onProjectMissingChange: (isMissing: boolean) => void;
  }) => {
    queueMicrotask(() => {
      onProjectMissingChange(mockProjectMissingState.current);
    });
    return null;
  },
  AgentPermissionDropdown: ({
    labels
  }: {
    labels: { permissionFullAccess: string };
  }) => <button type="button">{labels.permissionFullAccess}</button>,
  AgentPermissionModeDropdown: ({
    labels
  }: {
    labels: { permissionLabel: string; planModeLabel: string };
  }) => (
    <div
      data-testid="agent-permission-mode-dropdown"
      data-plan-mode-label={labels.planModeLabel}
    >
      {labels.permissionLabel}
    </div>
  ),
  AgentModelReasoningDropdown: () => (
    <div data-testid="agent-model-reasoning-dropdown" />
  )
}));

vi.mock("./AgentSlashCommandPalette", () => ({
  AgentSlashCommandPalette: ({
    capabilitiesGroupLabel,
    commandsGroupLabel,
    entries,
    onSelect,
    onSelectCapability,
    onSelectSkill,
    skillsGroupLabel
  }: {
    capabilitiesGroupLabel?: string;
    commandsGroupLabel: string;
    entries: any[];
    onSelect: (command: any) => void;
    onSelectCapability?: (capability: any) => void;
    onSelectSkill: (skill: any) => void;
    skillsGroupLabel: string;
  }) => (
    <div data-testid="mock-slash-palette">
      {entries.some((entry) => entry.type === "command") ? (
        <div>{commandsGroupLabel}</div>
      ) : null}
      {entries.some((entry) => entry.type === "capability") ? (
        <div>{capabilitiesGroupLabel}</div>
      ) : null}
      {entries.some((entry) => entry.type === "skill") ? (
        <div>{skillsGroupLabel}</div>
      ) : null}
      {entries.map((entry) => (
        <button
          key={entry.key}
          type="button"
          onClick={() => {
            if (entry.type === "command") {
              onSelect(entry.command);
            } else if (entry.type === "capability") {
              onSelectCapability?.(entry.capability);
            } else {
              onSelectSkill(entry.skill);
            }
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  )
}));

vi.mock("./AgentInteractivePromptSurface", () => ({
  AgentInteractivePromptSurface: () => null
}));

vi.mock("./AgentQueuedPromptPanel", () => ({
  AgentQueuedPromptPanel: ({
    queuedPrompts
  }: {
    queuedPrompts: readonly AgentGUIQueuedPromptVM[];
  }) => <div data-testid="queued-prompts-count">{queuedPrompts.length}</div>
}));

vi.mock("./AgentFileMentionPalette", () => ({
  AgentFileMentionPalette: () => null,
  flattenAgentMentionPaletteEntries: () => []
}));

vi.mock("./AgentMentionSearchController", () => ({
  AgentMentionSearchController: class {
    subscribe() {
      return () => undefined;
    }
    dispose() {}
    close() {}
    updateQuery() {}
    setFilter() {}
    expandGroup() {}
  }
}));

describe("AgentComposer", () => {
  it("does not render the permission access entry in the footer", () => {
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    expect(
      screen.queryByRole("button", { name: "完全访问权限" })
    ).not.toBeInTheDocument();
  });

  it("renders the permission dropdown when only plan mode is supported", () => {
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          supportsPlanMode: true
        })}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    // Plan mode rides the permission dropdown: the dropdown renders from the
    // plan capability alone, with the plan label wired through.
    const dropdown = screen.getByTestId("agent-permission-mode-dropdown");
    expect(dropdown).toHaveAttribute("data-plan-mode-label", "Plan");
  });

  it("does not render the browser-use footer toggle when supported", () => {
    const onSettingsChange = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          supportsBrowser: true
        })}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={onSettingsChange}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Browser use" })
    ).not.toBeInTheDocument();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("exposes browser-use through the slash capability group", async () => {
    const onDraftContentChange = vi.fn();
    const onSettingsChange = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("/浏览")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          draftSettings: {
            model: null,
            reasoningEffort: null,
            speed: null,
            planMode: false,
            browserUse: false,
            permissionModeId: "preset"
          },
          supportsBrowser: true
        })}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={onSettingsChange}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    const palette = await screen.findByTestId("mock-slash-palette");
    expect(palette).toHaveTextContent("能力");
    const browserCapability = within(palette).getByRole("button", {
      name: "浏览器"
    });

    fireEvent.click(browserCapability);

    expect(onDraftContentChange).toHaveBeenCalledWith(createDraft("/browser "));
    expect(screen.getByRole("textbox")).toHaveValue("/browser ");
    expect(onSettingsChange).toHaveBeenCalledWith({ browserUse: true });
  });

  it("submits browser capability tokens through the tutti browser-use handoff", () => {
    const onSubmit = vi.fn();
    const onSettingsChange = vi.fn();
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("/browser inspect this page")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          supportsBrowser: true
        })}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={onSettingsChange}
        onSubmit={onSubmit}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    fireEvent.submit(container.querySelector("form")!);

    expect(onSettingsChange).toHaveBeenCalledWith({ browserUse: true });
    expect(onSubmit).toHaveBeenCalledWith([
      {
        type: "text",
        text: expect.stringMatching(/browser-use[\s\S]*inspect this page/)
      }
    ]);
  });

  it("matches the browser-use slash capability by its English alias", async () => {
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("/browser")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          supportsBrowser: true
        })}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    const palette = await screen.findByTestId("mock-slash-palette");
    expect(
      within(palette).getByRole("button", { name: "浏览器" })
    ).toBeTruthy();
  });

  it("renders the permission dropdown while plan mode is enabled", () => {
    const onSettingsChange = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          draftSettings: {
            model: null,
            reasoningEffort: null,
            speed: null,
            planMode: true,
            permissionModeId: "preset"
          },
          supportsPlanMode: true
        })}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={onSettingsChange}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    expect(
      screen.getByTestId("agent-permission-mode-dropdown")
    ).toBeInTheDocument();
    void onSettingsChange;
  });

  it("shows effective plan mode even when draft settings are stale", () => {
    const onSettingsChange = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="claude-code"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          draftSettings: {
            model: null,
            reasoningEffort: null,
            speed: null,
            planMode: false,
            permissionModeId: "preset"
          },
          effectivePlanMode: true,
          supportsPlanMode: true
        })}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={onSettingsChange}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    expect(
      screen.getByTestId("agent-permission-mode-dropdown")
    ).toBeInTheDocument();
    void onSettingsChange;
  });

  it("blocks Claude Code plan slash command submissions", () => {
    const onDraftContentChange = vi.fn();
    const onSettingsChange = vi.fn();
    const onSubmit = vi.fn();
    const { container, unmount } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="claude-code"
        draftContent={createDraft("/plan")}
        availableCommands={
          [
            { name: "plan", description: "provider plan" }
          ] satisfies readonly AgentHostAgentSessionCommand[]
        }
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          supportsPlanMode: true
        })}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={onSettingsChange}
        onSubmit={onSubmit}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    fireEvent.submit(container.querySelector("form")!);

    expect(onDraftContentChange).toHaveBeenCalledWith(createDraft(""));
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    unmount();
    onDraftContentChange.mockClear();
    onSettingsChange.mockClear();
    onSubmit.mockClear();
    const secondRender = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="claude-code"
        draftContent={createDraft("/plan refactor auth")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={onSettingsChange}
        onSubmit={onSubmit}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    fireEvent.submit(secondRender.container.querySelector("form")!);

    expect(onDraftContentChange).toHaveBeenCalledWith(createDraft(""));
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits goal slash commands to Codex and Claude Code runtimes", () => {
    for (const provider of ["codex", "claude-code"] as const) {
      const onDraftContentChange = vi.fn();
      const onSubmit = vi.fn();
      const { container, unmount } = render(
        <AgentComposer
          workspaceId="workspace-1"
          currentUserId="user-1"
          provider={provider}
          draftContent={createDraft("/goal ship the review picker")}
          availableCommands={
            [] satisfies readonly AgentHostAgentSessionCommand[]
          }
          disabled={false}
          submitDisabled={false}
          placeholder="placeholder"
          composerSettings={createComposerSettings()}
          queuedPrompts={[]}
          drainingQueuedPromptId={null}
          canQueueWhileBusy={false}
          showStopButton={false}
          activePrompt={null}
          isInterrupting={false}
          isSendingTurn={false}
          isSubmittingPrompt={false}
          labels={createLabels()}
          workspaceUserProjectI18n={workspaceUserProjectI18n}
          onDraftContentChange={onDraftContentChange}
          onSettingsChange={vi.fn()}
          onSubmit={onSubmit}
          onSendQueuedPromptNext={vi.fn()}
          onRemoveQueuedPrompt={vi.fn()}
          onEditQueuedPrompt={vi.fn()}
          onInterruptCurrentTurn={vi.fn()}
          onSubmitInteractivePrompt={vi.fn()}
        />
      );

      fireEvent.submit(container.querySelector("form")!);

      expect(onSubmit).toHaveBeenCalledWith([
        { type: "text", text: "/goal ship the review picker" }
      ]);
      expect(onDraftContentChange).toHaveBeenCalledWith(createDraft(""));
      unmount();
    }
  });

  it("clears the visible draft immediately after a normal prompt submit", () => {
    let draftContent = createDraft("run the tests");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
    const onSubmit = vi.fn();
    const renderComposer = () => (
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={draftContent}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={vi.fn()}
        onSubmit={onSubmit}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );
    const { container, rerender } = render(renderComposer());

    const editor = screen.getByPlaceholderText("placeholder");
    expect(editor).toHaveValue("run the tests");

    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledWith([
      { type: "text", text: "run the tests" }
    ]);
    expect(onDraftContentChange).toHaveBeenCalledWith(createDraft(""));
    rerender(renderComposer());
    expect(editor).toHaveValue("");
  });

  it("toggles a persistent status panel for the local status slash command", () => {
    const { container, rerender } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        slashStatus={{
          agentSessionId: "agent-session-1",
          contextWindow: {
            usedTokens: 132_881,
            totalTokens: 258_000
          },
          limits: [
            {
              id: "session",
              label: "5h limit",
              value: "79% left",
              reset: "resets 21:31"
            },
            {
              id: "weekly",
              label: "7d limit",
              value: "95% left",
              reset: "resets Jun 18"
            }
          ]
        }}
        draftContent={createDraft("/status")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    fireEvent.submit(container.querySelector("form")!);

    const panel = screen.getByTestId("agent-gui-slash-status-panel");
    expect(panel).toHaveTextContent("Status");
    expect(panel).toHaveClass("agent-gui-node__slash-status-panel");
    expect(panel).toHaveTextContent("agent-session-1");
    expect(panel).toHaveTextContent("48% left (132,881 used / 258,000)");
    expect(panel).toHaveTextContent("5h limit");
    expect(panel).toHaveTextContent("79% left");
    expect(panel).toHaveTextContent("7d limit");
    expect(panel).toHaveTextContent("95% left");

    rerender(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        slashStatus={{
          agentSessionId: "agent-session-1",
          contextWindow: {
            usedTokens: 132_881,
            totalTokens: 258_000
          },
          limits: [
            {
              id: "session",
              label: "5h limit",
              value: "79% left",
              reset: "resets 21:31"
            }
          ]
        }}
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );
    rerender(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        slashStatus={{
          agentSessionId: "agent-session-1",
          contextWindow: {
            usedTokens: 132_881,
            totalTokens: 258_000
          },
          limits: [
            {
              id: "session",
              label: "5h limit",
              value: "79% left",
              reset: "resets 21:31"
            }
          ]
        }}
        draftContent={createDraft("/status")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );
    fireEvent.submit(container.querySelector("form")!);

    expect(
      screen.queryByTestId("agent-gui-slash-status-panel")
    ).not.toBeInTheDocument();
  });

  it("shows only usage limits in the status panel before a session exists", () => {
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        slashStatus={{
          limits: [
            {
              id: "weekly",
              label: "7d limit",
              value: "95% left",
              reset: "resets Jun 18"
            }
          ]
        }}
        draftContent={createDraft("/status")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    fireEvent.submit(container.querySelector("form")!);

    const panel = screen.getByTestId("agent-gui-slash-status-panel");
    expect(panel).toHaveTextContent("Status");
    expect(panel).toHaveTextContent("7d limit");
    expect(panel).toHaveTextContent("95% left");
    expect(panel).not.toHaveTextContent("Session");
    expect(panel).not.toHaveTextContent("Context");
  });

  it("keeps the status panel inset and squared off against the composer input", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__slash-status-panel\s*{[^}]*position:\s*relative[^}]*z-index:\s*1[^}]*margin:\s*0 12px[^}]*border-bottom:\s*0[^}]*border-radius:\s*10px 10px 0 0/s
    );
  });

  it("closes the status panel when the active session changes", () => {
    const { container, rerender } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        slashStatus={{ agentSessionId: "agent-session-a" }}
        draftContent={createDraft("/status")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );
    fireEvent.submit(container.querySelector("form")!);
    expect(
      screen.getByTestId("agent-gui-slash-status-panel")
    ).toHaveTextContent("agent-session-a");

    rerender(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        slashStatus={{ agentSessionId: "agent-session-b" }}
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    expect(
      screen.queryByTestId("agent-gui-slash-status-panel")
    ).not.toBeInTheDocument();
  });

  it("keeps the model and send controls pinned to the right side of the footer", () => {
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    const footer = container.querySelector(".agent-gui-node__composer-footer");
    expect(footer).not.toBeNull();
    expect(footer?.lastElementChild?.className).toContain(
      "agent-gui-node__composer-footer-right"
    );
  });

  it("keeps footer action spacing and chevron slots consistent", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__composer-footer-right\s*{[^}]*gap:\s*2px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-footer-right\s+\.agent-gui-node__composer-menu-trigger\s+>\s+svg\s*{[^}]*width:\s*16px[^}]*height:\s*16px[^}]*flex:\s*0 0 16px[^}]*margin-left:\s*0/s
    );
  });

  it("does not render the project dropdown below the dock input shell", () => {
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    const footerLeft = container.querySelector(
      ".agent-gui-node__composer-footer-left"
    );
    const referenceDropdown = screen.getByRole("combobox", {
      name: "引用空间文件"
    });
    expect(footerLeft?.firstElementChild).toBe(referenceDropdown);
    expect(referenceDropdown).toHaveAttribute("data-slot", "select-trigger");
    const addIcon = referenceDropdown.querySelector(
      '[data-agent-reference-add-icon="true"]'
    );
    expect(addIcon).not.toBeNull();
    expect(addIcon).toHaveClass("size-3.5");
    expect(screen.queryByTestId("agent-project-dropdown")).toBeNull();

    const inputShell = container.querySelector(
      ".agent-gui-node__composer-input-shell"
    );
    const projectRow = container.querySelector(
      ".agent-gui-node__composer-project-row"
    );
    const inputGroup = container.querySelector(
      ".agent-gui-node__composer-input-group"
    );
    expect(inputGroup).not.toBeNull();
    expect(projectRow).toBeNull();
    expect(inputShell?.parentElement).toBe(inputGroup);
    expect(inputGroup).not.toHaveClass(
      "agent-gui-node__composer-input-group-hero"
    );
    expect(inputShell?.nextElementSibling).toBeNull();

    expect(
      container.querySelector(
        '[data-slot="select-content"] [data-value="__tutti_workspace_reference_add__"]'
      )
    ).toBeNull();
  });

  it("hides the project row for locked dock composers in existing conversations", () => {
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({ projectLocked: true })}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    expect(
      container.querySelector(".agent-gui-node__composer-project-row")
    ).toBeNull();
    expect(screen.queryByTestId("agent-project-dropdown")).toBeNull();
  });

  it("shows a strong missing directory notice and disables input for locked stale projects", async () => {
    mockProjectMissingState.current = true;
    const onSubmit = vi.fn();
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          projectLocked: true,
          selectedProjectPath: "/workspace/deleted"
        })}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={onSubmit}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    expect(
      container.querySelector(".agent-gui-node__composer-project-row")
    ).toBeNull();
    expect(screen.queryByTestId("agent-project-dropdown")).toBeNull();
    const missingProjectNotice = await screen.findByTestId(
      "agent-gui-missing-project-notice"
    );
    expect(missingProjectNotice).toHaveTextContent("当前工作目录不存在");
    expect(missingProjectNotice).toHaveClass("agent-gui-chrome__card--danger");
    expect(
      missingProjectNotice.closest(".agent-gui-chrome__session-chrome")
    ).not.toBeNull();
    expect(
      missingProjectNotice.querySelector(".agent-gui-chrome__icon")
    ).toBeNull();
    const inputGroup = container.querySelector(
      ".agent-gui-node__composer-input-group"
    );
    const inputShell = container.querySelector(
      ".agent-gui-node__composer-input-shell"
    );
    expect(inputGroup).not.toBeNull();
    expect(inputGroup).not.toHaveAttribute("data-project-missing");
    expect(inputShell).not.toBeNull();
    expect(inputShell).not.toHaveAttribute("data-project-missing");
    expect(screen.getByPlaceholderText("placeholder")).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the project row visible in the hero composer", () => {
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({ projectLocked: true })}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        layoutMode="hero"
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    expect(
      container.querySelector(".agent-gui-node__composer-project-row")
    ).not.toBeNull();
    expect(screen.getByTestId("agent-project-dropdown")).toBeTruthy();
    expect(
      container.querySelector(".agent-gui-node__composer-input-group")
    ).toHaveAttribute("data-edge-glow", "true");
    expect(
      container.querySelector(".agent-gui-node__composer-input-shell")
    ).not.toHaveAttribute("data-edge-glow");
    expect(
      container.querySelector(".agent-gui-node__composer-input-group")
    ).toHaveClass("agent-gui-node__composer-input-group-hero");
    expect(
      container.querySelector(".agent-gui-node__composer-input-shell")
    ).toHaveClass("agent-gui-node__composer-input-shell-hero");
  });

  it("hides the hero project selector when disabled while keeping prompt tips", () => {
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        promptTips={[
          {
            id: "set-workspace",
            label: "指定工作区",
            prompt: "让 Agent 知道在哪里读文件、运行命令和理解代码"
          }
        ]}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        layoutMode="hero"
        showProjectSelector={false}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    expect(screen.queryByTestId("agent-project-dropdown")).toBeNull();
    expect(
      container.querySelector(".agent-gui-node__composer-project-row")
    ).not.toBeNull();
    expect(screen.getByTestId("agent-gui-prompt-tips")).toHaveTextContent(
      "Tips：指定工作区"
    );
  });

  it("keeps the hero composer shell visually flattened inside the glow frame", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__composer-input-group-hero\s*{[^}]*border:\s*1px solid var\(--agent-gui-border-focus\)[^}]*background:\s*var\(--agent-gui-accent-bg\)/s
    );
    expect(css).toMatch(/--agent-gui-package-accent:\s*var\(--accent-codex\)/);
    expect(css).toMatch(
      /--agent-gui-package-border-focus:\s*var\(--accent-codex-border\)/
    );
    expect(css).toMatch(
      /html\[data-theme="light"\][\s\S]*?\.agent-gui-node__composer-input-group\[data-edge-glow="true"\]\s*{[^}]*--agent-gui-star-border-color:\s*color-mix\(\s*in srgb,\s*var\(--accent-codex\) 90%,\s*transparent\s*\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-menu-trigger\[data-permission-tone="accent"\],[\s\S]*?\.agent-gui-node__composer-menu-trigger\[data-permission-tone="accent"\]\s*>\s*svg\s*{[^}]*color:\s*var\(--tutti-purple\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-menu-content\s*{[^}]*--accent:\s*var\(--tutti-purple\)[^}]*--agent-gui-package-accent:\s*var\(--tutti-purple\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-input-shell-hero\s*{[^}]*border-color:\s*transparent[^}]*border-radius:\s*14px[^}]*box-shadow:\s*none/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-input-shell-hero:hover,[\s\S]*?\.agent-gui-node__composer-input-shell-hero:focus-within\s*{[^}]*border-color:\s*transparent[^}]*box-shadow:\s*none/s
    );
  });

  it("renders hero prompt tips as a CSS ticker without editing the draft", () => {
    const onDraftContentChange = vi.fn();
    const onSubmit = vi.fn();
    const firstPrompt = "让 Agent 知道在哪里读文件、运行命令和理解代码";
    const secondPrompt = "让上下文接力更完整，减少关键信息丢失";

    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        promptTips={[
          {
            id: "set-workspace",
            label: "指定工作区",
            prompt: firstPrompt
          },
          {
            id: "reference-other-agents",
            label: "引用其他 Agent 对话历史",
            prompt: secondPrompt
          }
        ]}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        layoutMode="hero"
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={vi.fn()}
        onSubmit={onSubmit}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    const tips = screen.getByTestId("agent-gui-prompt-tips");
    const tip = screen.getByTestId("agent-gui-prompt-tip");
    expect(within(tips).queryByRole("button")).toBeNull();
    expect(tip).toHaveAttribute("data-rotating", "true");
    expect(tips).toHaveTextContent(`Tips：指定工作区 · ${firstPrompt}`);
    expect(tips).toHaveTextContent(
      `Tips：引用其他 Agent 对话历史 · ${secondPrompt}`
    );
    expect(onDraftContentChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("shows the full prompt tip in a tooltip when the text overflows", async () => {
    const scrollWidth = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockImplementation(function getScrollWidth(this: HTMLElement) {
        return this.dataset.testid === "agent-gui-prompt-tip" ? 520 : 0;
      });
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(function getClientWidth(this: HTMLElement) {
        return this.dataset.testid === "agent-gui-prompt-tip" ? 180 : 0;
      });
    const fullPrompt =
      "让 Agent 知道在哪里读文件、运行命令和理解代码，并在当前工作区持续推进";

    try {
      render(
        <AgentComposer
          workspaceId="workspace-1"
          currentUserId="user-1"
          provider="codex"
          draftContent={createDraft("")}
          availableCommands={
            [] satisfies readonly AgentHostAgentSessionCommand[]
          }
          disabled={false}
          submitDisabled={false}
          placeholder="placeholder"
          composerSettings={createComposerSettings()}
          queuedPrompts={[]}
          drainingQueuedPromptId={null}
          canQueueWhileBusy={false}
          showStopButton={false}
          activePrompt={null}
          promptTips={[
            {
              id: "set-workspace",
              label: "指定工作区",
              prompt: fullPrompt
            }
          ]}
          isInterrupting={false}
          isSendingTurn={false}
          isSubmittingPrompt={false}
          labels={createLabels()}
          workspaceUserProjectI18n={workspaceUserProjectI18n}
          layoutMode="hero"
          onDraftContentChange={vi.fn()}
          onSettingsChange={vi.fn()}
          onSubmit={vi.fn()}
          onSendQueuedPromptNext={vi.fn()}
          onRemoveQueuedPrompt={vi.fn()}
          onEditQueuedPrompt={vi.fn()}
          onInterruptCurrentTurn={vi.fn()}
          onSubmitInteractivePrompt={vi.fn()}
        />
      );

      const tip = screen.getByTestId("agent-gui-prompt-tip");
      fireEvent.pointerMove(tip, { pointerType: "mouse" });

      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        `Tips：指定工作区 · ${fullPrompt}`
      );
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    }
  });

  it("keeps the edge glow limited to the hero composer", () => {
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    expect(
      container.querySelector(".agent-gui-node__composer-input-group")
    ).not.toHaveAttribute("data-edge-glow");
  });

  it("keeps the rich text editor anchored to the top of the composer grid", () => {
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    const editor = container.querySelector(
      'textarea[placeholder="placeholder"]'
    );
    expect(editor?.parentElement?.className).toContain("self-start");

    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    expect(css).toMatch(
      /\.agent-gui-node__composer-textarea\s*{[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-textarea\s*{[^}]*max-height:\s*72px;[^}]*overflow-y:\s*auto;[^}]*scrollbar-width:\s*thin;[^}]*scrollbar-gutter:\s*stable/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-textarea::-webkit-scrollbar\s*{[^}]*display:\s*block;[^}]*width:\s*4px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-textarea::-webkit-scrollbar-thumb\s*{[^}]*background:\s*var\(--transparency-hover\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-textarea p\s*{[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-textarea[\s\S]*?\.agent-rich-text-placeholder-node:first-child::before\s*{[^}]*font-size:\s*13px/s
    );
  });

  it("adds dropped system images on the AgentGUI detail panel to draft images", async () => {
    let draftContent = createDraft("");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
    const renderComposer = () => (
      <div id="agent-gui-detail">
        <AgentComposer
          workspaceId="workspace-1"
          currentUserId="user-1"
          provider="codex"
          draftContent={draftContent}
          availableCommands={
            [] satisfies readonly AgentHostAgentSessionCommand[]
          }
          disabled={false}
          submitDisabled={false}
          placeholder="placeholder"
          composerSettings={createComposerSettings()}
          queuedPrompts={[]}
          drainingQueuedPromptId={null}
          canQueueWhileBusy={false}
          showStopButton={false}
          activePrompt={null}
          isInterrupting={false}
          isSendingTurn={false}
          isSubmittingPrompt={false}
          labels={createLabels()}
          workspaceUserProjectI18n={workspaceUserProjectI18n}
          onDraftContentChange={onDraftContentChange}
          onSettingsChange={vi.fn()}
          onSubmit={vi.fn()}
          onSendQueuedPromptNext={vi.fn()}
          onRemoveQueuedPrompt={vi.fn()}
          onEditQueuedPrompt={vi.fn()}
          onInterruptCurrentTurn={vi.fn()}
          onSubmitInteractivePrompt={vi.fn()}
        />
      </div>
    );
    const { container, rerender } = render(renderComposer());

    const detailPanel = container.querySelector("#agent-gui-detail");
    expect(detailPanel).not.toBeNull();
    const dataTransfer = createImageDataTransfer(
      new File(["image"], "panel.png", { type: "image/png" })
    );

    fireEvent.dragOver(detailPanel!, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(detailPanel!, { dataTransfer });
    await waitFor(() => expect(onDraftContentChange).toHaveBeenCalled());
    rerender(renderComposer());

    const drafts = await screen.findByTestId("agent-gui-composer-image-drafts");
    await waitFor(() =>
      expect(within(drafts).getByAltText("panel.png")).toHaveAttribute(
        "src",
        "data:image/png;base64,aW1hZ2U="
      )
    );
  });

  it("uses the tracked spinner while the send button is waiting for a turn to start", () => {
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("hello")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={true}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    const spinner = screen.getByTestId("agent-gui-composer-send-spinner");
    const circles = spinner.querySelectorAll("circle");
    expect(circles).toHaveLength(2);
    expect(circles[0]).toHaveAttribute("stroke", "var(--transparency-hover)");
    expect(circles[1]).toHaveAttribute("stroke", "currentColor");
    expect(circles[1]).toHaveAttribute("stroke-width", "2.5");
  });

  it("lets a busy composer submit a draft into the local queue", () => {
    const onSubmit = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("queue while loading")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={true}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={true}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={onSubmit}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    const sendButton = screen.getByRole("button", { name: "发送" });
    expect(sendButton).not.toBeDisabled();
    expect(sendButton).toHaveAttribute("data-state", "queue");
    fireEvent.click(sendButton);
    expect(onSubmit).toHaveBeenCalledWith([
      { type: "text", text: "queue while loading" }
    ]);
  });

  it("lets a busy composer queue an image-only draft instead of showing stop", () => {
    let draftContent = createDraft("");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
    const onSubmit = vi.fn();
    const renderComposer = () => (
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={draftContent}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={true}
        showStopButton={true}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={true}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={vi.fn()}
        onSubmit={onSubmit}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );
    const { rerender } = render(renderComposer());

    fireEvent.click(screen.getByTestId("mock-paste-image"));
    rerender(renderComposer());

    const sendButton = screen.getByRole("button", { name: "发送" });
    expect(sendButton).not.toBeDisabled();
    expect(sendButton).toHaveAttribute("data-state", "queue");
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    fireEvent.click(sendButton);
    expect(onSubmit).toHaveBeenCalledWith([
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
        name: "screen.png"
      }
    ]);
    rerender(renderComposer());
    expect(
      screen.queryByTestId("agent-gui-composer-image-drafts")
    ).not.toBeInTheDocument();
  });

  it("renders controlled text and image draft content", () => {
    const onSubmit = vi.fn();
    const draftContent = createDraft("describe this", [
      {
        id: "queued-image-1",
        name: "panel.png",
        mimeType: "image/png",
        data: "aW1hZ2U=",
        previewUrl: "data:image/png;base64,aW1hZ2U="
      }
    ]);
    const expectedContent = [
      { type: "text" as const, text: "describe this" },
      {
        type: "image" as const,
        mimeType: "image/png" as const,
        data: "aW1hZ2U=",
        name: "panel.png"
      }
    ];
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={draftContent}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={onSubmit}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    expect(screen.getByDisplayValue("describe this")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "panel.png" })).toHaveAttribute(
      "src",
      "data:image/png;base64,aW1hZ2U="
    );

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSubmit).toHaveBeenCalledWith(expectedContent);
  });

  it("keeps pasted image previews visible while the prompt is submitting", () => {
    let draftContent = createDraft("");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
    const onSubmit = vi.fn();
    const renderComposer = (isSubmittingPrompt: boolean) => (
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={draftContent}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={isSubmittingPrompt}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={vi.fn()}
        onSubmit={onSubmit}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );
    const { container, rerender } = render(renderComposer(false));

    fireEvent.click(screen.getByTestId("mock-paste-image"));
    rerender(renderComposer(false));
    expect(
      screen.getByTestId("agent-gui-composer-image-drafts")
    ).not.toHaveAttribute("data-submitted-preview");
    expect(screen.getByRole("img", { name: "screen.png" })).toHaveAttribute(
      "src",
      "data:image/png;base64,aW1hZ2U="
    );

    fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledWith([
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
        name: "screen.png"
      }
    ]);

    rerender(renderComposer(true));

    const submittedPreview = screen.getByTestId(
      "agent-gui-composer-image-drafts"
    );
    expect(submittedPreview).toHaveAttribute("data-submitted-preview", "true");
    expect(screen.getByRole("img", { name: "screen.png" })).toHaveAttribute(
      "src",
      "data:image/png;base64,aW1hZ2U="
    );
    expect(
      screen.queryByRole("button", { name: "移除引用" })
    ).not.toBeInTheDocument();
  });

  it("rejects pasted images when prompt images are unsupported", () => {
    const onSubmit = vi.fn();
    const onPromptImagesUnsupported = vi.fn();
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="claude-code"
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={false}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        promptImagesSupported={false}
        labels={createLabels()}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={vi.fn()}
        onSettingsChange={vi.fn()}
        onSubmit={onSubmit}
        onPromptImagesUnsupported={onPromptImagesUnsupported}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("mock-paste-image"));
    expect(
      screen.queryByTestId("agent-gui-composer-image-drafts")
    ).not.toBeInTheDocument();
    expect(onPromptImagesUnsupported).toHaveBeenCalledTimes(1);

    fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude-code"] as const)(
    "opens the %s review picker and submits the chosen target",
    (provider) => {
      const onSubmit = vi.fn();
      const { container } = render(
        <AgentComposer
          workspaceId="workspace-1"
          currentUserId="user-1"
          provider={provider}
          slashStatus={{ agentSessionId: "agent-session-1", limits: [] }}
          draftContent={createDraft("/review")}
          availableCommands={
            [
              { name: "review" }
            ] satisfies readonly AgentHostAgentSessionCommand[]
          }
          disabled={false}
          submitDisabled={false}
          placeholder="placeholder"
          composerSettings={createComposerSettings()}
          queuedPrompts={[]}
          drainingQueuedPromptId={null}
          canQueueWhileBusy={false}
          showStopButton={false}
          activePrompt={null}
          isInterrupting={false}
          isSendingTurn={false}
          isSubmittingPrompt={false}
          labels={createLabels()}
          workspaceUserProjectI18n={workspaceUserProjectI18n}
          onDraftContentChange={vi.fn()}
          onSettingsChange={vi.fn()}
          onSubmit={onSubmit}
          onSendQueuedPromptNext={vi.fn()}
          onRemoveQueuedPrompt={vi.fn()}
          onEditQueuedPrompt={vi.fn()}
          onInterruptCurrentTurn={vi.fn()}
          onSubmitInteractivePrompt={vi.fn()}
        />
      );

      fireEvent.submit(container.querySelector("form")!);
      expect(
        screen.getByTestId("agent-gui-review-picker-panel")
      ).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();

      // Selecting the "uncommitted changes" scope submits a bare /review.
      fireEvent.click(screen.getByText("未提交的更改"));
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0]?.[0]).toEqual([
        { type: "text", text: "/review" }
      ]);
    }
  );

  it.each(["codex", "claude-code"] as const)(
    "submits %s /review <text> as a custom review without opening the picker",
    (provider) => {
      const onSubmit = vi.fn();
      const { container } = render(
        <AgentComposer
          workspaceId="workspace-1"
          currentUserId="user-1"
          provider={provider}
          slashStatus={{ agentSessionId: "agent-session-1", limits: [] }}
          draftContent={createDraft("/review check the auth flow")}
          availableCommands={
            [
              { name: "review" }
            ] satisfies readonly AgentHostAgentSessionCommand[]
          }
          disabled={false}
          submitDisabled={false}
          placeholder="placeholder"
          composerSettings={createComposerSettings()}
          queuedPrompts={[]}
          drainingQueuedPromptId={null}
          canQueueWhileBusy={false}
          showStopButton={false}
          activePrompt={null}
          isInterrupting={false}
          isSendingTurn={false}
          isSubmittingPrompt={false}
          labels={createLabels()}
          workspaceUserProjectI18n={workspaceUserProjectI18n}
          onDraftContentChange={vi.fn()}
          onSettingsChange={vi.fn()}
          onSubmit={onSubmit}
          onSendQueuedPromptNext={vi.fn()}
          onRemoveQueuedPrompt={vi.fn()}
          onEditQueuedPrompt={vi.fn()}
          onInterruptCurrentTurn={vi.fn()}
          onSubmitInteractivePrompt={vi.fn()}
        />
      );

      fireEvent.submit(container.querySelector("form")!);
      expect(
        screen.queryByTestId("agent-gui-review-picker-panel")
      ).not.toBeInTheDocument();
      expect(onSubmit).toHaveBeenCalledTimes(1);
    }
  );
});

function createComposerSettings(
  overrides: Partial<AgentGUIComposerSettingsVM> = {}
): AgentGUIComposerSettingsVM {
  return {
    sessionSettings: null,
    draftSettings: {
      model: null,
      reasoningEffort: null,
      speed: null,
      planMode: false,
      permissionModeId: "preset"
    },
    supportsModel: true,
    supportsReasoningEffort: true,
    supportsSpeed: true,
    speedUnavailable: false,
    availableSpeeds: [],
    supportsPlanMode: false,
    isSettingsLoading: false,
    modelUnavailable: false,
    reasoningUnavailable: false,
    planUnavailable: false,
    availableModels: [{ value: "gpt-5.5", label: "GPT-5.5" }],
    availableReasoningEfforts: [{ value: "high", label: "高" }],
    ...overrides
  };
}

function createLabels(): Parameters<typeof AgentComposer>[0]["labels"] {
  return {
    send: "发送",
    modelLabel: "模型",
    modelSelectionLabel: "模型选择",
    defaultModel: "默认模型",
    inheritedUnavailable: "不可用",
    loadingConversation: "加载会话中",
    reasoningLabel: "推理",
    reasoningDegreeLabel: "推理强度",
    reasoningOptionMinimal: "最少",
    reasoningOptionLow: "低",
    reasoningOptionMedium: "中",
    reasoningOptionHigh: "高",
    reasoningOptionXHigh: "超高",
    speedLabel: "Speed",
    speedSelectionLabel: "Speed",
    speedOptionStandard: "Standard",
    speedOptionFast: "Fast",
    permissionLabel: "运行权限",
    permissionModeReadOnly: "请求批准",
    permissionModeAuto: "代我批准",
    permissionModeFullAccess: "完全访问权限",
    modelDescriptions: {
      frontierComplexCoding: "复杂编码模型说明",
      everydayCoding: "日常编码模型说明",
      smallFastCostEfficient: "小型快速模型说明",
      codingOptimized: "编码优化模型说明",
      ultraFastCoding: "超快编码模型说明",
      professionalLongRunning: "专业长任务模型说明"
    },
    planModeLabel: "Plan",
    planModeOnLabel: "开启",
    planModeOffLabel: "关闭",
    planUnavailable: "计划不可用",
    browserUseCapabilityLabel: "浏览器",
    browserUseCapabilityDescription: "让 Agent 使用浏览器。",
    queuedLabel: "排队",
    sendQueuedPromptNext: "下一条发送",
    editQueuedPrompt: "编辑",
    deleteQueuedPrompt: "删除",
    queuedPromptMoreActions: "更多",
    stop: "停止",
    stopping: "停止中",
    slashCommandPalette: "斜杠命令",
    skillPickerPalette: "技能",
    slashPaletteCommandsGroup: "命令",
    slashPaletteCapabilitiesGroup: "能力",
    slashPaletteSkillsGroup: "技能",
    slashStatusTitle: "Status",
    slashStatusSession: "Session",
    slashStatusBaseUrl: "Base URL",
    slashStatusContext: "Context",
    slashStatusLimits: "Limit",
    slashStatusClose: "Close",
    slashStatusContextValue: ({ percentLeft, usedTokens, totalTokens }) =>
      `${percentLeft}% left (${usedTokens} used / ${totalTokens})`,
    slashStatusContextUnavailable: "Context usage unavailable",
    slashStatusLimitsUnavailable: "Rate limits unavailable",
    approvalLead: "审批",
    planLead: "计划",
    planModes: [],
    projectLocked: "项目已锁定",
    projectMissingDescription: "此对话的工作目录已不存在",
    promptTipsPrefix: "Tips：",
    stayInPlan: "保持计划模式",
    sendFeedback: "发送反馈",
    feedbackPlaceholder: "反馈",
    previousQuestion: "上一题",
    nextQuestion: "下一题",
    submitAnswers: "提交答案",
    answerPlaceholder: "填写答案",
    waitingForAnswer: "等待回答",
    planImplementationLead: "实作此方案？",
    planImplementationConfirm: "实作方案",
    planImplementationFeedbackPlaceholder: "调整方案…",
    planImplementationSend: "发送调整",
    planImplementationSkip: "留在计划模式",
    fileMentionPalette: "文件",
    fileMentionLoading: "加载中",
    fileMentionEmpty: "空",
    fileMentionError: "错误",
    fileMentionTabHint: "Tab 提示",
    removeMention: "移除引用",
    addReference: "添加引用",
    referenceWorkspaceFiles: "引用空间文件",
    reviewPicker: {
      title: "代码审查",
      targetLabel: "审查范围",
      searchPlaceholder: "搜索",
      noResults: "无匹配结果",
      uncommitted: "未提交的更改",
      baseBranch: "与分支比较",
      commit: "指定提交",
      custom: "自定义说明",
      branchLabel: "基准分支",
      branchPlaceholder: "选择分支",
      branchLoading: "正在加载分支…",
      branchEmpty: "未找到分支",
      commitPlaceholder: "提交 SHA",
      customPlaceholder: "描述要审查的内容",
      submit: "开始审查",
      cancel: "取消"
    }
  };
}
