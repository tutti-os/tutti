import {
  act,
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
import { textPromptContent } from "./controller/agentGuiController.promptHelpers";
import {
  resetAgentActivityRuntimeForTests,
  setAgentActivityRuntimeForTests,
  type AgentActivityRuntime,
  type AgentActivityRuntimeStagePastedTextResult,
  type AgentActivityRuntimeUploadPromptContentResult
} from "../../agentActivityRuntime";
import type {
  AgentComposerDraft,
  AgentComposerDraftFile,
  AgentComposerDraftImage,
  AgentComposerDraftLargeText,
  AgentGUIComposerSettingsVM,
  AgentGUIQueuedPromptVM
} from "./model/agentGuiNodeTypes";
import type { AgentHostAgentSessionCommand } from "../../shared/contracts/dto";
import {
  agentComposerDraftImages,
  agentComposerDraftLargeTexts,
  agentComposerDraftPrompt,
  buildAgentComposerDraft
} from "./model/agentComposerDraft";

const { mockEditorFocusAtEnd, mockProjectMissingState } = vi.hoisted(() => ({
  mockEditorFocusAtEnd: vi.fn(),
  mockProjectMissingState: {
    current: false
  }
}));

afterEach(() => {
  mockEditorFocusAtEnd.mockClear();
  mockProjectMissingState.current = false;
  resetAgentActivityRuntimeForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const workspaceUserProjectI18n = createWorkspaceUserProjectI18nRuntime(
  createI18nRuntime({
    dictionaries: [workspaceUserProjectI18nResources["zh-CN"]]
  })
);

function createDraft(
  prompt: string,
  images: AgentComposerDraftImage[] = [],
  files: AgentComposerDraftFile[] = [],
  largeTexts?: AgentComposerDraftLargeText[]
): AgentComposerDraft {
  return buildAgentComposerDraft({ prompt, images, files, largeTexts });
}

function createFileDataTransfer(files: readonly File[]): DataTransfer {
  return {
    effectAllowed: "copy",
    dropEffect: "none",
    types: ["Files"],
    files,
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file
    }))
  } as unknown as DataTransfer;
}

function createProtectedFileDragDataTransfer(
  files: readonly File[]
): DataTransfer {
  const dataTransfer = createFileDataTransfer(files) as unknown as {
    files: readonly File[];
    items: Array<{ getAsFile: () => File | null }>;
  };
  dataTransfer.files = [];
  dataTransfer.items = dataTransfer.items.map((item) => ({
    ...item,
    getAsFile: () => null
  }));
  return dataTransfer as unknown as DataTransfer;
}

function createImageDataTransfer(file: File): DataTransfer {
  return createFileDataTransfer([file]);
}

async function openUsagePopoverByHover(usageChip: HTMLElement): Promise<void> {
  vi.useFakeTimers();
  fireEvent.pointerOver(usageChip, { pointerType: "mouse" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120);
  });
}

vi.mock("@tutti-os/ui-system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tutti-os/ui-system")>();
  const React = await import("react");
  interface MockPopoverContextValue {
    onOpenChange?: (open: boolean) => void;
    open: boolean;
  }
  const MockPopoverContext = React.createContext<MockPopoverContextValue>({
    open: false
  });
  type MockPopoverRootProps = {
    children?: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
  };
  type MockPopoverTriggerProps = {
    asChild?: boolean;
    children?: React.ReactNode;
  };
  type MockPopoverContentProps = React.ComponentProps<"div"> & {
    align?: string;
    collisionPadding?: number;
    onOpenAutoFocus?: (event: Event) => void;
    side?: string;
    sideOffset?: number;
  };
  return {
    ...actual,
    Popover: ({
      children,
      onOpenChange,
      open = false
    }: MockPopoverRootProps) => (
      <MockPopoverContext.Provider value={{ onOpenChange, open }}>
        {children}
      </MockPopoverContext.Provider>
    ),
    PopoverAnchor: ({ children }: { children?: React.ReactNode }) => (
      <>{children}</>
    ),
    PopoverTrigger: ({ children }: MockPopoverTriggerProps) => {
      const { onOpenChange, open } = React.useContext(MockPopoverContext);
      if (React.isValidElement<React.HTMLAttributes<HTMLElement>>(children)) {
        const existingOnClick = children.props.onClick;
        return React.cloneElement(children, {
          onClick: (event: React.MouseEvent<HTMLElement>) => {
            existingOnClick?.(event);
            onOpenChange?.(!open);
          }
        });
      }
      return <>{children}</>;
    },
    PopoverContent: React.forwardRef<HTMLDivElement, MockPopoverContentProps>(
      (
        {
          align,
          children,
          collisionPadding: _collisionPadding,
          onOpenAutoFocus: _onOpenAutoFocus,
          side,
          sideOffset: _sideOffset,
          ...props
        },
        ref
      ) => (
        <div ref={ref} data-align={align} data-side={side} {...props}>
          {children}
        </div>
      )
    )
  };
});

vi.mock("./agentRichText/AgentRichTextEditor", async () => {
  const React = await import("react");
  return {
    AgentRichTextEditor: React.forwardRef(
      (
        {
          disabled,
          onChange,
          onPasteImages,
          onPasteLargeText,
          onFileMentionSuggestionChange,
          onKeyDownForPalette,
          onSubmit,
          onSubmitGuidance,
          className,
          value,
          placeholder
        }: {
          className?: string;
          disabled?: boolean;
          onChange: (value: string) => void;
          onFileMentionSuggestionChange?: (state: any) => void;
          onPasteImages?: (images: unknown[]) => void;
          onPasteLargeText?: (text: string) => void;
          onKeyDownForPalette?: (event: KeyboardEvent) => boolean;
          onSubmit?: () => void;
          onSubmitGuidance?: () => void;
          value: string;
          placeholder: string;
        },
        ref
      ) => {
        React.useEffect(() => {
          if (!value.startsWith("@")) {
            return;
          }
          onFileMentionSuggestionChange?.({
            editor: {
              view: {
                state: {
                  tr: {
                    setMeta() {
                      return this;
                    }
                  }
                },
                dispatch() {}
              }
            },
            range: { from: 1, to: value.length + 1 },
            query: value.slice(1),
            text: value,
            command: vi.fn()
          });
        }, [onFileMentionSuggestionChange, value]);
        React.useImperativeHandle(ref, () => ({
          focusAtStart() {},
          focusAtEnd: mockEditorFocusAtEnd,
          getPromptTextBeforeSelection() {
            return value;
          },
          openMentionPalette() {
            onChange(`${value}@`);
          },
          insertWorkspaceReferences(
            items: ReadonlyArray<{ displayName?: string; path: string }>
          ) {
            const mentions = items
              .map((item) => {
                const name = item.displayName?.trim() || item.path;
                return `[@${name}](${item.path})`;
              })
              .join(" ");
            onChange(`${value}${mentions} `);
          },
          insertMentionItems(
            items: ReadonlyArray<{ href: string; name: string }>
          ) {
            const mentions = items
              .map((item) => `[@${item.name}](${item.href})`)
              .join(" ");
            onChange(`${value}${mentions} `);
          },
          replaceTextBeforeSelection(_length: number, text: string) {
            const nextValue = `${value.slice(0, Math.max(0, value.length - _length))}${text}`;
            onChange(nextValue);
            return nextValue;
          }
        }));
        return (
          <>
            <textarea
              className={className}
              value={value}
              placeholder={placeholder}
              disabled={disabled}
              onChange={(event) => onChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (onKeyDownForPalette?.(event.nativeEvent)) {
                  event.preventDefault();
                  return;
                }
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.shiftKey &&
                  !event.altKey
                ) {
                  event.preventDefault();
                  onSubmitGuidance?.();
                  return;
                }
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.altKey
                ) {
                  event.preventDefault();
                  onSubmit?.();
                }
              }}
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
            <button
              type="button"
              data-testid="mock-paste-large-text"
              onClick={() =>
                onPasteLargeText?.("first pasted line\nsecond pasted line")
              }
            >
              paste large text
            </button>
          </>
        );
      }
    )
  };
});

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
    labels: { permissionLabel: string };
  }) => (
    <div data-testid="agent-permission-mode-dropdown">
      {labels.permissionLabel}
    </div>
  ),
  AgentModelReasoningDropdown: () => (
    <div data-testid="agent-model-reasoning-dropdown" />
  )
}));

vi.mock("./AgentSlashCommandPalette", () => ({
  AgentSlashCommandPalette: ({
    capabilitiesLoading,
    capabilitiesLoadingLabel,
    capabilitiesGroupLabel,
    commandsGroupLabel,
    entries,
    onSelect,
    onSelectCapability,
    onSelectCapabilitySettings,
    onSelectSkill,
    connectorsGroupLabel,
    pluginsGroupLabel,
    skillsGroupLabel
  }: {
    capabilitiesLoading?: boolean;
    capabilitiesLoadingLabel?: string;
    capabilitiesGroupLabel?: string;
    commandsGroupLabel: string;
    connectorsGroupLabel: string;
    entries: any[];
    onSelect: (command: any) => void;
    onSelectCapability?: (capability: any) => void;
    onSelectCapabilitySettings?: (capability: any) => void;
    onSelectSkill: (skill: any) => void;
    pluginsGroupLabel: string;
    skillsGroupLabel: string;
  }) => (
    <div data-testid="mock-slash-palette">
      {capabilitiesLoading ? <div>{capabilitiesLoadingLabel}</div> : null}
      {entries.some((entry) => entry.type === "command") ? (
        <div>{commandsGroupLabel}</div>
      ) : null}
      {entries.some((entry) => entry.type === "capability") ? (
        <div>{capabilitiesGroupLabel}</div>
      ) : null}
      {entries.some(
        (entry) =>
          entry.type === "skill" &&
          entry.skill?.sourceKind !== "plugin" &&
          entry.skill?.sourceKind !== "connector" &&
          entry.skill?.kind !== "connector"
      ) ? (
        <div>{skillsGroupLabel}</div>
      ) : null}
      {entries.some(
        (entry) =>
          entry.type === "skill" && entry.skill?.sourceKind === "plugin"
      ) ? (
        <div>{pluginsGroupLabel}</div>
      ) : null}
      {entries.some(
        (entry) =>
          entry.type === "skill" &&
          (entry.skill?.sourceKind === "connector" ||
            entry.skill?.kind === "connector")
      ) ? (
        <div>{connectorsGroupLabel}</div>
      ) : null}
      {entries.map((entry) => (
        <div key={entry.key}>
          <button
            type="button"
            onClick={() => {
              if (entry.type === "command") {
                onSelect(entry.command);
              } else if (entry.type === "capability") {
                if (entry.selectAction === "settings") {
                  onSelectCapabilitySettings?.(entry.capability);
                } else {
                  onSelectCapability?.(entry.capability);
                }
              } else {
                onSelectSkill(entry.skill);
              }
            }}
          >
            {entry.primaryLabel ?? entry.label}
            {entry.secondaryLabel ? ` ${entry.secondaryLabel}` : ""}
          </button>
          {entry.type === "capability" && entry.settingsLabel ? (
            <button
              aria-label={entry.settingsAriaLabel ?? entry.settingsLabel}
              type="button"
              onClick={() => onSelectCapabilitySettings?.(entry.capability)}
            >
              {entry.settingsLabel}
            </button>
          ) : null}
          {entry.description ? <span>{entry.description}</span> : null}
        </div>
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
  AgentFileMentionPalette: ({
    onOpenReferences
  }: {
    onOpenReferences?: (item: any) => void;
  }) =>
    onOpenReferences ? (
      <button
        type="button"
        data-testid="mock-open-references"
        onClick={() =>
          onOpenReferences({
            kind: "workspace-issue",
            href: "mention://workspace-issue/issue-1?workspaceId=workspace-1",
            workspaceId: "workspace-1",
            targetId: "issue-1",
            topicId: "topic-1",
            name: "制作一个1000字小说",
            title: "制作一个1000字小说"
          })
        }
      >
        查看产物
      </button>
    ) : null,
  agentMentionItemKey: (item: {
    kind: string;
    targetId?: string;
    path?: string;
  }) => `${item.kind}:${item.kind === "file" ? item.path : item.targetId}`,
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
  it("shows settings loading controls before new-session composer options arrive", () => {
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
          supportsModel: false,
          supportsReasoningEffort: false,
          supportsSpeed: false,
          supportsPermissionMode: false,
          isSettingsLoading: true,
          availableModels: [],
          availableReasoningEfforts: [],
          availableSpeeds: [],
          availablePermissionModes: []
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

    expect(
      screen.getByTestId("agent-permission-mode-dropdown")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-model-reasoning-dropdown")
    ).toBeInTheDocument();
  });

  it("hides the permission dropdown and the plan badge when only plan mode is supported and inactive", () => {
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

    // The permission dropdown now renders only for permission capability, and
    // plan rides as a separate badge that only appears while plan is active.
    expect(
      screen.queryByTestId("agent-permission-mode-dropdown")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Plan" })
    ).not.toBeInTheDocument();
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
        capabilityMenuState={{
          browserUse: { connectionMode: "isolated" }
        }}
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
    expect(palette).toHaveTextContent("当前配置：使用独立浏览器。");
    const browserCapability = within(palette).getByRole("button", {
      name: "浏览器"
    });

    fireEvent.click(browserCapability);

    expect(onDraftContentChange).toHaveBeenCalledWith(createDraft("/browser "));
    expect(screen.getByRole("textbox")).toHaveValue("/browser ");
    expect(onSettingsChange).toHaveBeenCalledWith({ browserUse: true });
  });

  it("opens the slash palette while initial capabilities are loading", async () => {
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="cursor"
        draftContent={createDraft("/")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          isCapabilityOptionsLoading: true
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

    expect(await screen.findByTestId("mock-slash-palette")).toHaveTextContent(
      "能力加载中…"
    );
  });

  it("requests browser-use settings from the slash capability group", async () => {
    const onDraftContentChange = vi.fn();
    const onSettingsChange = vi.fn();
    const onCapabilitySettingsRequest = vi.fn();
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
        onCapabilitySettingsRequest={onCapabilitySettingsRequest}
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
    fireEvent.click(
      within(palette).getByRole("button", { name: "浏览器设置" })
    );

    expect(onCapabilitySettingsRequest).toHaveBeenCalledWith("browserUse");
    expect(onDraftContentChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("shows localized descriptions for built-in slash commands", async () => {
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("/")}
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

    const palette = await screen.findByTestId("mock-slash-palette");
    expect(palette).toHaveTextContent("查看会话状态和上下文用量。");
    expect(palette).toHaveTextContent("切换快速响应模式。");
    expect(palette).toHaveTextContent("设置、查看或清除当前目标。");
    expect(palette).toHaveTextContent("发起代码审查。");
    expect(palette).toHaveTextContent("切换计划模式。");
  });

  it("uses typed catalog authority to filter provider command noise", async () => {
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="claude-code"
        draftContent={createDraft("/")}
        availableCommands={
          [
            { name: "context" },
            { name: "usage" },
            { name: "plugin-noise" }
          ] satisfies readonly AgentHostAgentSessionCommand[]
        }
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          slashCommandPolicy: {
            fallbackCommands: ["context", "usage"],
            commandCatalogAuthoritative: true,
            commandEffects: []
          }
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
    expect(palette).toHaveTextContent("查看当前上下文快照。");
    expect(palette).toHaveTextContent("查看上下文和额度用量。");
    expect(palette).not.toHaveTextContent("plugin-noise");
  });

  it("shows Chinese slash command labels with English aliases in zh-CN", async () => {
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("/")}
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
        uiLanguage="zh-CN"
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
    expect(palette).toHaveTextContent("状态 status");
    expect(palette).toHaveTextContent("快速 fast");
    expect(palette).toHaveTextContent("目标 goal");
  });

  it("activates goal mode as a footer badge from the slash palette", async () => {
    let draftContent = createDraft("/");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
      rerender(renderComposer());
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

    fireEvent.click(screen.getByRole("button", { name: "目标" }));

    expect(onDraftContentChange).toHaveBeenCalledWith(createDraft("/goal"));
    const goalBadge = screen.getByRole("button", { name: "目标" });
    expect(goalBadge).toBeInTheDocument();
    // Hovering the badge reveals a cancel affordance hinting it is clickable.
    expect(goalBadge).toHaveClass("group");
    expect(goalBadge.querySelector(".group-hover\\:opacity-100")).toBeTruthy();
    expect(screen.getByRole("textbox")).toHaveValue("");

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "ship the review picker" }
    });

    expect(onDraftContentChange).toHaveBeenLastCalledWith(
      createDraft("/goal ship the review picker")
    );
    expect(screen.getByRole("textbox")).toHaveValue("ship the review picker");

    fireEvent.submit(screen.getByRole("textbox").closest("form")!);

    expect(onSubmit).toHaveBeenCalledWith([
      { type: "text", text: "/goal ship the review picker" }
    ]);
  });

  it("turns a typed /goal command into a footer badge and keeps plain text when cleared", () => {
    let draftContent = createDraft("");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
      rerender(renderComposer());
    });
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
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );
    const { rerender } = render(renderComposer());

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/goal" }
    });

    expect(onDraftContentChange).toHaveBeenCalledWith(createDraft("/goal"));
    expect(screen.getByRole("button", { name: "目标" })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "stabilize renderer sync" }
    });
    expect(onDraftContentChange).toHaveBeenLastCalledWith(
      createDraft("/goal stabilize renderer sync")
    );

    fireEvent.click(screen.getByRole("button", { name: "目标" }));

    expect(onDraftContentChange).toHaveBeenLastCalledWith(
      createDraft("stabilize renderer sync")
    );
    expect(screen.getByRole("textbox")).toHaveValue("stabilize renderer sync");
    expect(
      screen.queryByRole("button", { name: "目标" })
    ).not.toBeInTheDocument();
  });

  it("keeps /goal as plain prompt text when goal control is disabled", () => {
    const onDraftContentChange = vi.fn();
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
        canGoalControl={false}
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
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/goal ship it" }
    });

    expect(onDraftContentChange).toHaveBeenCalledWith(
      createDraft("/goal ship it")
    );
    expect(
      screen.queryByRole("button", { name: "目标" })
    ).not.toBeInTheDocument();
  });

  it("opens computer-use setup from Enter when the capability is not installed", async () => {
    const onDraftContentChange = vi.fn();
    const onSettingsChange = vi.fn();
    const onCapabilitySettingsRequest = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("/电脑")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          supportsComputerUse: true
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
        capabilityMenuState={{
          computerUse: { installed: false }
        }}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onCapabilitySettingsRequest={onCapabilitySettingsRequest}
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
    expect(palette).toHaveTextContent("未安装。按 Enter 打开设置。");

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onCapabilitySettingsRequest).toHaveBeenCalledWith("computerUse");
    expect(onDraftContentChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("opens computer-use setup from Enter when permissions are incomplete", async () => {
    const onDraftContentChange = vi.fn();
    const onSettingsChange = vi.fn();
    const onCapabilitySettingsRequest = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("/电脑")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          supportsComputerUse: true
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
        capabilityMenuState={{
          computerUse: {
            authorization: "needs-authorization",
            installed: true
          }
        }}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onCapabilitySettingsRequest={onCapabilitySettingsRequest}
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
    expect(palette).toHaveTextContent("需要授权。按 Enter 打开设置。");

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onCapabilitySettingsRequest).toHaveBeenCalledWith("computerUse");
    expect(onDraftContentChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("opens computer-use setup from Enter when permission status is unknown", async () => {
    const onDraftContentChange = vi.fn();
    const onSettingsChange = vi.fn();
    const onCapabilitySettingsRequest = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("/电脑")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          supportsComputerUse: true
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
        capabilityMenuState={{
          computerUse: {
            authorization: "unknown",
            installed: true
          }
        }}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onCapabilitySettingsRequest={onCapabilitySettingsRequest}
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
    expect(palette).toHaveTextContent("无法确认授权状态。按 Enter 打开设置。");

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onCapabilitySettingsRequest).toHaveBeenCalledWith("computerUse");
    expect(onDraftContentChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
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
    expect(onSubmit).toHaveBeenCalledWith(
      [
        {
          type: "text",
          text: expect.stringMatching(/browser-use[\s\S]*inspect this page/)
        }
      ],
      "/browser inspect this page"
    );
  });

  it("fires handoff when the only menu option is selected", async () => {
    const onHandoffConversation = vi.fn();
    const codexTarget = {
      targetId: "local:codex",
      agentTargetId: "local:codex",
      provider: "codex" as const,
      ref: { kind: "local-provider", provider: "codex" as const },
      label: "Codex"
    };
    const claudeTarget = {
      targetId: "local:claude-code",
      agentTargetId: "local:claude-code",
      provider: "claude-code" as const,
      ref: { kind: "local-provider", provider: "claude-code" as const },
      label: "Claude Code"
    };

    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        selectedAgentTarget={codexTarget}
        agentTargets={[codexTarget, claudeTarget]}
        providerSelectReadonly
        onHandoffConversation={onHandoffConversation}
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

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Handoff" }), {
      key: "ArrowDown"
    });
    fireEvent.click(await screen.findByRole("option", { name: "Claude Code" }));

    expect(onHandoffConversation).toHaveBeenCalledWith(claudeTarget);
  });

  it("omits targets that are not handoff-capable from the handoff menu", async () => {
    const codexTarget = {
      targetId: "local:codex",
      agentTargetId: "local:codex",
      provider: "codex" as const,
      ref: { kind: "local-provider", provider: "codex" as const },
      label: "Codex"
    };
    const claudeTarget = {
      targetId: "local:claude-code",
      agentTargetId: "local:claude-code",
      provider: "claude-code" as const,
      ref: { kind: "local-provider", provider: "claude-code" as const },
      label: "Claude Code"
    };
    const cursorTarget = {
      targetId: "local:cursor",
      agentTargetId: "local:cursor",
      provider: "cursor" as const,
      ref: { kind: "local-provider", provider: "cursor" as const },
      label: "Cursor"
    };

    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        selectedAgentTarget={codexTarget}
        agentTargets={[codexTarget, claudeTarget, cursorTarget]}
        handoffAgentTargets={[codexTarget, claudeTarget]}
        providerSelectReadonly
        onHandoffConversation={vi.fn()}
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

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Handoff" }), {
      key: "ArrowDown"
    });

    expect(
      await screen.findByRole("option", { name: "Claude Code" })
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Cursor" })
    ).not.toBeInTheDocument();
  });

  it("shows a handoff tooltip label on the handoff trigger", () => {
    const codexTarget = {
      targetId: "local:codex",
      agentTargetId: "local:codex",
      provider: "codex" as const,
      ref: { kind: "local-provider", provider: "codex" as const },
      label: "Codex"
    };
    const claudeTarget = {
      targetId: "local:claude-code",
      agentTargetId: "local:claude-code",
      provider: "claude-code" as const,
      ref: { kind: "local-provider", provider: "claude-code" as const },
      label: "Claude Code"
    };

    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        selectedAgentTarget={codexTarget}
        agentTargets={[codexTarget, claudeTarget]}
        providerSelectReadonly
        onHandoffConversation={vi.fn()}
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

    expect(screen.getByRole("combobox", { name: "Handoff" })).toHaveAttribute(
      "title",
      "交接给其他 Agent"
    );
  });

  it("marks the handoff icon disabled with the handoff trigger", () => {
    const codexTarget = {
      targetId: "local:codex",
      agentTargetId: "local:codex",
      provider: "codex" as const,
      ref: { kind: "local-provider", provider: "codex" as const },
      label: "Codex"
    };
    const claudeTarget = {
      targetId: "local:claude-code",
      agentTargetId: "local:claude-code",
      provider: "claude-code" as const,
      ref: { kind: "local-provider", provider: "claude-code" as const },
      label: "Claude Code"
    };

    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        selectedAgentTarget={codexTarget}
        agentTargets={[codexTarget, claudeTarget]}
        providerSelectReadonly
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

    const handoffTrigger = screen.getByRole("combobox", { name: "Handoff" });
    const handoffIcon = handoffTrigger.querySelector(
      ".agent-gui-node__composer-handoff-icon"
    );

    expect(handoffTrigger).toBeDisabled();
    expect(handoffIcon).toHaveAttribute("data-disabled", "true");
  });

  it("keeps unavailable targets visible and selectable in the provider switch menu", async () => {
    const codexTarget = {
      targetId: "local:codex",
      agentTargetId: "local:codex",
      provider: "codex" as const,
      ref: { kind: "local-provider", provider: "codex" as const },
      label: "Codex"
    };
    const claudeTarget = {
      targetId: "local:claude-code",
      agentTargetId: "local:claude-code",
      provider: "claude-code" as const,
      ref: { kind: "local-provider", provider: "claude-code" as const },
      label: "Claude Code"
    };
    const disabledTargets = [
      {
        targetId: "local:tutti",
        agentTargetId: "local:tutti",
        provider: "nexight" as const,
        ref: { kind: "local-provider", provider: "nexight" as const },
        label: "Tutti Agent",
        disabled: true
      },
      {
        targetId: "local:hermes",
        agentTargetId: "local:hermes",
        provider: "hermes" as const,
        ref: { kind: "local-provider", provider: "hermes" as const },
        label: "Hermes",
        disabled: true
      },
      {
        targetId: "local:openclaw",
        agentTargetId: "local:openclaw",
        provider: "openclaw" as const,
        ref: { kind: "local-provider", provider: "openclaw" as const },
        label: "OpenClaw",
        disabled: true
      }
    ];

    const onProviderSelect = vi.fn();

    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="claude-code"
        selectedAgentTarget={claudeTarget}
        agentTargets={[codexTarget, claudeTarget, ...disabledTargets]}
        providerSelectLabel="切换 Provider"
        onProviderSelect={onProviderSelect}
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

    fireEvent.keyDown(screen.getByRole("combobox", { name: "切换 Provider" }), {
      key: "ArrowDown"
    });

    expect(await screen.findByRole("option", { name: "Codex" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Claude Code" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Tutti Agent" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Hermes" })).toBeVisible();
    expect(screen.getByRole("option", { name: "OpenClaw" })).toBeVisible();

    fireEvent.click(screen.getByRole("option", { name: "Tutti Agent" }));
    expect(onProviderSelect).toHaveBeenCalledWith({
      provider: disabledTargets[0]!.provider,
      agentTargetId: disabledTargets[0]!.targetId
    });
  });

  it("honors target artwork in the provider switch menu", async () => {
    const codexTarget = {
      targetId: "local:codex",
      agentTargetId: "local:codex",
      provider: "codex" as const,
      ref: { kind: "local-provider", provider: "codex" as const },
      label: "Codex"
    };
    const cursorTarget = {
      targetId: "local:cursor",
      agentTargetId: "local:cursor",
      provider: "cursor" as const,
      ref: { kind: "local-provider", provider: "cursor" as const },
      label: "Cursor",
      iconUrl: "app://old-cursor-target-icon.png"
    };

    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="cursor"
        selectedAgentTarget={cursorTarget}
        agentTargets={[codexTarget, cursorTarget]}
        providerSelectLabel="切换 Provider"
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

    const trigger = screen.getByRole("combobox", { name: "切换 Provider" });
    expect(trigger.querySelector("img")).toHaveAttribute(
      "src",
      "app://old-cursor-target-icon.png"
    );

    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    expect(
      (await screen.findByRole("option", { name: "Cursor" })).querySelector(
        "img"
      )
    ).toHaveAttribute("src", "app://old-cursor-target-icon.png");
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

  it("renders the plan badge while plan mode is enabled and clears it on click", () => {
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

    const badge = screen.getByRole("button", { name: "Plan" });
    expect(badge).toBeInTheDocument();

    fireEvent.click(badge);
    expect(onSettingsChange).toHaveBeenCalledWith({ planMode: false });
  });

  it.each([
    { provider: "codex" as const, planMode: false, expected: true },
    { provider: "claude-code" as const, planMode: true, expected: false }
  ])(
    "toggles plan mode on Shift+Tab for $provider (draft-driven, unified)",
    ({ provider, planMode, expected }) => {
      const onSettingsChange = vi.fn();
      render(
        <AgentComposer
          workspaceId="workspace-1"
          currentUserId="user-1"
          provider={provider}
          draftContent={createDraft("")}
          availableCommands={
            [] satisfies readonly AgentHostAgentSessionCommand[]
          }
          disabled={false}
          submitDisabled={false}
          placeholder="placeholder"
          composerSettings={createComposerSettings({
            draftSettings: {
              model: null,
              reasoningEffort: null,
              speed: null,
              planMode,
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

      fireEvent.keyDown(screen.getByRole("textbox"), {
        key: "Tab",
        shiftKey: true
      });

      expect(onSettingsChange).toHaveBeenCalledWith({ planMode: expected });
    }
  );

  it("toggles plan mode on /plan slash command submission", () => {
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
          supportsPlanMode: true,
          slashCommandPolicy: {
            fallbackCommands: [],
            commandEffects: [{ command: "plan", effect: "togglePlanMode" }]
          }
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

    // /plan is a local plan-mode toggle, not an agent prompt.
    expect(onSettingsChange).toHaveBeenCalledWith({ planMode: true });
    expect(onDraftContentChange).toHaveBeenCalledWith(createDraft(""));
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
        composerSettings={createComposerSettings({
          supportsPlanMode: true,
          slashCommandPolicy: {
            fallbackCommands: [],
            commandEffects: [{ command: "plan", effect: "togglePlanMode" }]
          }
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

    fireEvent.submit(secondRender.container.querySelector("form")!);

    // Trailing args are ignored — it stays a local toggle, never submitted.
    expect(onSettingsChange).toHaveBeenCalledWith({ planMode: true });
    expect(onDraftContentChange).toHaveBeenCalledWith(createDraft(""));
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
      expect(onDraftContentChange).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("keeps the visible draft until the engine acknowledges a normal prompt submit", () => {
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
    expect(onDraftContentChange).not.toHaveBeenCalled();
    rerender(renderComposer());
    expect(editor).toHaveValue("run the tests");

    draftContent = createDraft("");
    rerender(renderComposer());
    expect(editor).toHaveValue("");
  });

  it("keeps submitted text visible until the parent acknowledges it", () => {
    let draftContent = createDraft("start a new session");
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
    expect(editor).toHaveValue("start a new session");

    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledWith([
      { type: "text", text: "start a new session" }
    ]);
    expect(onDraftContentChange).not.toHaveBeenCalled();
    rerender(renderComposer());
    expect(editor).toHaveValue("start a new session");

    draftContent = createDraft("");
    rerender(renderComposer());
    expect(editor).toHaveValue("");
  });

  it("sends Cmd+Enter through the guidance submit path", () => {
    const onSubmit = vi.fn();
    const onSubmitGuidance = vi.fn();
    const onDraftContentChange = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("steer the running turn")}
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
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={vi.fn()}
        onSubmit={onSubmit}
        onSubmitGuidance={onSubmitGuidance}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    fireEvent.keyDown(screen.getByPlaceholderText("placeholder"), {
      key: "Enter",
      metaKey: true
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSubmitGuidance).toHaveBeenCalledWith(
      textPromptContent("steer the running turn")
    );
    expect(onDraftContentChange).not.toHaveBeenCalled();
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
    expect(
      screen.getByTestId("agent-gui-command-menu-surface")
    ).toContainElement(panel);
    expect(panel).toHaveTextContent("Status");
    expect(panel).toHaveTextContent("7d limit");
    expect(panel).toHaveTextContent("95% left");
    expect(panel).not.toHaveTextContent("Session");
    expect(panel).not.toHaveTextContent("Context");
  });

  it("closes the status command menu with Escape", () => {
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
              value: "95% left"
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
      screen.getByTestId("agent-gui-slash-status-panel")
    ).toBeInTheDocument();

    fireEvent.keyDown(screen.getByPlaceholderText("placeholder"), {
      key: "Escape"
    });

    expect(
      screen.queryByTestId("agent-gui-slash-status-panel")
    ).not.toBeInTheDocument();
  });

  it("closes the status command menu when focus leaves the composer menu", () => {
    const { container } = render(
      <>
        <AgentComposer
          workspaceId="workspace-1"
          currentUserId="user-1"
          provider="codex"
          slashStatus={{
            limits: [
              {
                id: "weekly",
                label: "7d limit",
                value: "95% left"
              }
            ]
          }}
          draftContent={createDraft("/status")}
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
          onDraftContentChange={vi.fn()}
          onSettingsChange={vi.fn()}
          onSubmit={vi.fn()}
          onSendQueuedPromptNext={vi.fn()}
          onRemoveQueuedPrompt={vi.fn()}
          onEditQueuedPrompt={vi.fn()}
          onInterruptCurrentTurn={vi.fn()}
          onSubmitInteractivePrompt={vi.fn()}
        />
        <button type="button">outside target</button>
      </>
    );

    fireEvent.submit(container.querySelector("form")!);
    expect(
      screen.getByTestId("agent-gui-command-menu-surface")
    ).toBeInTheDocument();

    screen.getByText("outside target").focus();
    fireEvent.focusIn(screen.getByText("outside target"));

    expect(
      screen.queryByTestId("agent-gui-command-menu-surface")
    ).not.toBeInTheDocument();
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
  it("opens context usage details after hovering the usage chip", async () => {
    vi.useFakeTimers();

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
              percentRemaining: 96,
              value: "96% left"
            }
          ]
        }}
        usage={{ usedTokens: 50_000, totalTokens: 200_000, percentUsed: 25 }}
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          supportsPlanMode: true,
          supportsPermissionMode: true
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

    const footerRight = container.querySelector(
      ".agent-gui-node__composer-footer-right"
    );
    const usageChip = screen.getByTestId("agent-gui-usage-chip");
    const permissionMenu = screen.getByTestId("agent-permission-mode-dropdown");
    const footerControls = Array.from(footerRight?.children ?? []).filter(
      (element) =>
        element.getAttribute("data-testid") !== "agent-gui-usage-popover"
    );
    expect(footerControls[0]).toBe(usageChip);
    expect(footerControls[1]).toBe(permissionMenu);
    expect(usageChip).toHaveAttribute("aria-label", "上下文 25%");
    expect(usageChip).toHaveAttribute("data-usage-level", "normal");
    expect(usageChip.tagName).toBe("BUTTON");
    expect(usageChip).toHaveClass("size-4");
    expect(usageChip).toHaveClass("mr-2");
    expect(usageChip).toHaveClass("cursor-pointer");
    expect(usageChip).not.toHaveAttribute("data-slot", "badge");
    expect(screen.queryByTestId("agent-gui-usage-popover")).toBeNull();

    fireEvent.pointerOver(usageChip, { pointerType: "mouse" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(119);
    });
    expect(screen.queryByTestId("agent-gui-usage-popover")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const usagePopover = screen.getByTestId("agent-gui-usage-popover");
    expect(usagePopover).toBeVisible();
    expect(usagePopover).toHaveAttribute("data-side", "top");
    expect(usagePopover).toHaveAttribute("data-align", "center");
    fireEvent.click(usageChip);
    expect(screen.getByTestId("agent-gui-usage-popover")).toBeVisible();
    expect(screen.getByTestId("agent-gui-usage-popover")).toHaveTextContent(
      "上下文用量"
    );
    expect(
      screen.getByTestId("agent-gui-usage-context-meter")
    ).toHaveTextContent("上下文窗口");
    expect(
      screen.getByTestId("agent-gui-usage-context-meter")
    ).toHaveTextContent("50,000 / 200,000 (25%)");
    // Plan limits moved out of the usage popover into the rail config menu.
    expect(screen.queryByText("7d limit")).toBeNull();
    expect(screen.queryByText("96% left")).toBeNull();

    fireEvent.pointerOut(usageChip, { pointerType: "mouse" });
    expect(screen.getByTestId("agent-gui-usage-popover")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(140);
    });
    expect(screen.queryByTestId("agent-gui-usage-popover")).toBeNull();
  });

  it("keeps the workspace reference action enabled while a session is running", () => {
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
        showStopButton={true}
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
        onRequestWorkspaceReferences={vi.fn()}
      />
    );

    expect(
      screen.getByRole("combobox", { name: "引用空间文件" })
    ).not.toBeDisabled();
  });

  it.each([
    [85, "warning"],
    [97, "critical"]
  ])("marks context usage level %s as %s", (percentUsed, level) => {
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        usage={{ usedTokens: null, totalTokens: null, percentUsed }}
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

    expect(screen.getByTestId("agent-gui-usage-chip")).toHaveAttribute(
      "data-usage-level",
      level
    );
  });

  it("shows compact context button in usage popover when compactSupported and hasCompactableContext", async () => {
    const onSubmit = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        usage={{ usedTokens: 50_000, totalTokens: 200_000, percentUsed: 25 }}
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
        compactSupported={true}
        hasCompactableContext={true}
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

    const usageChip = screen.getByTestId("agent-gui-usage-chip");
    await openUsagePopoverByHover(usageChip);

    const compactButton = screen.queryByTestId("agent-gui-compact-button");
    expect(compactButton).toBeInTheDocument();
    expect(compactButton).toHaveAttribute("data-variant", "secondary");
    expect(compactButton).toHaveAttribute("data-size", "sm");
    expect(compactButton).toHaveClass("h-7");
    fireEvent.click(compactButton!);
    expect(onSubmit).toHaveBeenCalledWith(textPromptContent("/compact"));
  });

  it("keeps the usage popover mounted when focus moves from the usage chip to the compact button", async () => {
    const onSubmit = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        usage={{ usedTokens: 50_000, totalTokens: 200_000, percentUsed: 25 }}
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
        compactSupported={true}
        hasCompactableContext={true}
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

    const usageChip = screen.getByTestId("agent-gui-usage-chip");
    await openUsagePopoverByHover(usageChip);
    fireEvent.focus(usageChip);
    const compactButton = screen.getByTestId("agent-gui-compact-button");

    fireEvent.pointerOut(usageChip, { pointerType: "mouse" });
    fireEvent.blur(usageChip, { relatedTarget: compactButton });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(140);
    });

    expect(screen.getByTestId("agent-gui-compact-button")).toBe(compactButton);
    fireEvent.click(compactButton);
    expect(onSubmit).toHaveBeenCalledWith(textPromptContent("/compact"));
  });

  it("does not show compact context button when compactSupported is false", () => {
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        usage={{ usedTokens: 50_000, totalTokens: 200_000, percentUsed: 25 }}
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
        compactSupported={false}
        hasCompactableContext={true}
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
      screen.queryByTestId("agent-gui-compact-button")
    ).not.toBeInTheDocument();
  });

  it("keeps the compact context button enabled while showStopButton is true but no turn is actively executing", async () => {
    // showStopButton alone (e.g. pending approval / interrupting, with
    // isSendingTurn false) must NOT disable compact -- that overly broad
    // gate was the bug fixed by 0e736412 and must not be reintroduced.
    const onSubmit = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        usage={{ usedTokens: 50_000, totalTokens: 200_000, percentUsed: 25 }}
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={true}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={false}
        isSubmittingPrompt={false}
        compactSupported={true}
        hasCompactableContext={true}
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

    await openUsagePopoverByHover(screen.getByTestId("agent-gui-usage-chip"));
    const compactButton = screen.getByTestId("agent-gui-compact-button");
    expect(compactButton).toBeInTheDocument();
    expect(compactButton).not.toBeDisabled();
    fireEvent.click(compactButton);
    expect(onSubmit).toHaveBeenCalledWith(textPromptContent("/compact"));
  });

  it("disables the compact context button while a turn is actively running (isSendingTurn=true)", async () => {
    const onSubmit = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        usage={{ usedTokens: 50_000, totalTokens: 200_000, percentUsed: 25 }}
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={true}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={true}
        isSubmittingPrompt={false}
        compactSupported={true}
        hasCompactableContext={true}
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

    await openUsagePopoverByHover(screen.getByTestId("agent-gui-usage-chip"));
    const compactButton = screen.getByTestId("agent-gui-compact-button");
    expect(compactButton).toBeInTheDocument();
    expect(compactButton).toBeDisabled();
    fireEvent.click(compactButton);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("re-enables the compact context button once the turn settles", async () => {
    const onSubmit = vi.fn();
    const renderComposer = (
      isSendingTurn: boolean,
      showStopButton: boolean
    ) => (
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        usage={{ usedTokens: 50_000, totalTokens: 200_000, percentUsed: 25 }}
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings()}
        queuedPrompts={[]}
        drainingQueuedPromptId={null}
        canQueueWhileBusy={false}
        showStopButton={showStopButton}
        activePrompt={null}
        isInterrupting={false}
        isSendingTurn={isSendingTurn}
        isSubmittingPrompt={false}
        compactSupported={true}
        hasCompactableContext={true}
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

    const { rerender } = render(renderComposer(true, true));

    await openUsagePopoverByHover(screen.getByTestId("agent-gui-usage-chip"));
    expect(screen.getByTestId("agent-gui-compact-button")).toBeDisabled();

    rerender(renderComposer(false, false));

    await openUsagePopoverByHover(screen.getByTestId("agent-gui-usage-chip"));
    expect(screen.getByTestId("agent-gui-compact-button")).not.toBeDisabled();
  });

  it("shows the compact context button disabled when no user message has been sent", async () => {
    const onSubmit = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        usage={{ usedTokens: 50_000, totalTokens: 200_000, percentUsed: 25 }}
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
        compactSupported={true}
        hasCompactableContext={false}
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

    await openUsagePopoverByHover(screen.getByTestId("agent-gui-usage-chip"));
    const compactButton = screen.getByTestId("agent-gui-compact-button");
    expect(compactButton).toBeDisabled();
    fireEvent.click(compactButton);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the compact context button disabled when the composer is blocked (read-only)", async () => {
    const onSubmit = vi.fn();
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        usage={{ usedTokens: 50_000, totalTokens: 200_000, percentUsed: 25 }}
        draftContent={createDraft("")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={true}
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
        compactSupported={true}
        hasCompactableContext={true}
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

    await openUsagePopoverByHover(screen.getByTestId("agent-gui-usage-chip"));
    const compactButton = screen.getByTestId("agent-gui-compact-button");
    expect(compactButton).toBeDisabled();
    fireEvent.click(compactButton);
    expect(onSubmit).not.toHaveBeenCalled();
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
    const referenceCluster = footerLeft?.firstElementChild;
    expect(referenceCluster).not.toBeNull();
    expect(referenceCluster).toHaveClass("gap-1");
    expect(referenceCluster?.firstElementChild).toBe(referenceDropdown);
    expect(referenceCluster).toContainElement(
      screen.getByRole("button", { name: "提及上下文" })
    );
    expect(referenceDropdown).toHaveAttribute("role", "combobox");
    expect(referenceDropdown).toHaveClass(
      "agent-gui-node__composer-reference-trigger"
    );
    expect(referenceDropdown.className).not.toContain("px-1");
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

  it("shows a hover tooltip explaining the mention (@) button", async () => {
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

    const mentionButton = screen.getByRole("button", { name: "提及上下文" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerMove(mentionButton, { pointerType: "mouse" });

    expect(await screen.findByRole("tooltip")).toHaveTextContent("提及上下文");
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

  it("skips the missing directory check for remote-cwd runtimes", async () => {
    mockProjectMissingState.current = true;
    const onSubmit = vi.fn();
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("hi")}
        availableCommands={[] satisfies readonly AgentHostAgentSessionCommand[]}
        disabled={false}
        submitDisabled={false}
        placeholder="placeholder"
        composerSettings={createComposerSettings({
          projectLocked: true,
          selectedProjectPath: "/sandbox/shared",
          projectPathIsRemote: true
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

    // Even with the probe reporting "missing", a remote-cwd runtime never
    // mounts it, so no danger notice and the input stays usable.
    expect(screen.queryByTestId("agent-gui-missing-project-notice")).toBeNull();
    expect(screen.getByPlaceholderText("placeholder")).not.toBeDisabled();
    fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
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
    expect(
      container.querySelector(
        ".agent-gui-node__composer-hero-prompt-input-area"
      )
    ).not.toBeNull();
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

  it("uploads dropped non-image system files on the AgentGUI detail panel as file mentions", async () => {
    let draftContent = createDraft("");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
    const uploadPromptContent = vi.fn(async () => ({
      content: [
        {
          type: "file" as const,
          path: "/var/cache/tsh/local-assets/room-1/report.pdf",
          name: "report.pdf",
          kind: "file" as const
        }
      ]
    }));
    setAgentActivityRuntimeForTests({
      uploadPromptContent
    } as unknown as AgentActivityRuntime);
    const report = new File(["report"], "report.pdf", {
      type: "application/pdf"
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
          resolveDroppedFileReferences={(files) =>
            files.map((file) => ({
              path: "/Users/local/Downloads/report.pdf",
              hostPath: "/Users/local/Downloads/report.pdf",
              displayName: file.name,
              kind: "file",
              sourceId: "host-local-file"
            }))
          }
        />
      </div>
    );
    const { container } = render(renderComposer());
    const detailPanel = container.querySelector("#agent-gui-detail");
    const dragDataTransfer = createProtectedFileDragDataTransfer([report]);
    const dataTransfer = createFileDataTransfer([report]);

    fireEvent.dragOver(detailPanel!, { dataTransfer: dragDataTransfer });
    expect(dragDataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(detailPanel!, { dataTransfer });

    await waitFor(() =>
      expect(uploadPromptContent).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        content: [
          {
            type: "file",
            hostPath: "/Users/local/Downloads/report.pdf",
            name: "report.pdf",
            kind: "file"
          }
        ]
      })
    );
    await waitFor(() =>
      expect(onDraftContentChange).toHaveBeenCalledWith(
        createDraft(
          "[@report.pdf](/var/cache/tsh/local-assets/room-1/report.pdf) "
        )
      )
    );
    expect(agentComposerDraftPrompt(draftContent)).not.toContain(
      "/Users/local/Downloads"
    );
  });

  it("does not accept dropped host files when prompt file uploads are unsupported", async () => {
    const uploadPromptContent = vi.fn();
    const resolveDroppedFileReferences = vi.fn(() => [
      {
        path: "/Users/local/Downloads/report.pdf",
        hostPath: "/Users/local/Downloads/report.pdf",
        displayName: "report.pdf",
        kind: "file" as const,
        sourceId: "host-local-file"
      }
    ]);
    const onDraftContentChange = vi.fn();
    setAgentActivityRuntimeForTests({
      promptContentUploadSupport: { file: false },
      uploadPromptContent
    } as unknown as AgentActivityRuntime);
    const report = new File(["report"], "report.pdf", {
      type: "application/pdf"
    });
    const { container } = render(
      <div id="agent-gui-detail">
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
          resolveDroppedFileReferences={resolveDroppedFileReferences}
        />
      </div>
    );
    const detailPanel = container.querySelector("#agent-gui-detail");
    const dragDataTransfer = createProtectedFileDragDataTransfer([report]);
    const dataTransfer = createFileDataTransfer([report]);

    fireEvent.dragOver(detailPanel!, { dataTransfer: dragDataTransfer });
    expect(dragDataTransfer.dropEffect).toBe("none");
    fireEvent.drop(detailPanel!, { dataTransfer });

    expect(resolveDroppedFileReferences).not.toHaveBeenCalled();
    expect(uploadPromptContent).not.toHaveBeenCalled();
    expect(onDraftContentChange).not.toHaveBeenCalled();
  });

  it("keeps mixed system image and file drops on their separate draft paths", async () => {
    let draftContent = createDraft("");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
    const uploadPromptContent = vi.fn(async () => ({
      content: [
        {
          type: "file" as const,
          path: "/var/cache/tsh/local-assets/room-1/report.pdf",
          name: "report.pdf",
          kind: "file" as const
        }
      ]
    }));
    setAgentActivityRuntimeForTests({
      uploadPromptContent
    } as unknown as AgentActivityRuntime);
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
          resolveDroppedFileReferences={(files) =>
            files.map((file) => ({
              path: "/Users/local/Downloads/report.pdf",
              hostPath: "/Users/local/Downloads/report.pdf",
              displayName: file.name,
              kind: "file",
              sourceId: "host-local-file"
            }))
          }
        />
      </div>
    );
    const { container, rerender } = render(renderComposer());
    const detailPanel = container.querySelector("#agent-gui-detail");
    const dataTransfer = createFileDataTransfer([
      new File(["image"], "panel.png", { type: "image/png" }),
      new File(["report"], "report.pdf", { type: "application/pdf" })
    ]);

    fireEvent.drop(detailPanel!, { dataTransfer });

    await waitFor(() =>
      expect(onDraftContentChange).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: "[@report.pdf](/var/cache/tsh/local-assets/room-1/report.pdf) "
          })
        ])
      )
    );
    await waitFor(() =>
      expect(agentComposerDraftImages(draftContent)).toEqual([
        expect.objectContaining({
          name: "panel.png",
          mimeType: "image/png",
          data: "aW1hZ2U="
        })
      ])
    );
    rerender(renderComposer());
    expect(
      await screen.findByTestId("agent-gui-composer-image-drafts")
    ).toBeInTheDocument();
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

    expect(
      screen.getByTestId("agent-gui-composer-send-spinner")
    ).toBeInTheDocument();
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
    onDraftContentChange.mockClear();
    fireEvent.click(sendButton);
    expect(onSubmit).toHaveBeenCalledWith([
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
        name: "screen.png"
      }
    ]);
    expect(onDraftContentChange).not.toHaveBeenCalled();
    draftContent = createDraft("");
    rerender(renderComposer());
    expect(
      screen.queryByTestId("agent-gui-composer-image-drafts")
    ).not.toBeInTheDocument();
  });

  it("keeps pasted large text out of the prompt when staging is unsupported", () => {
    setAgentActivityRuntimeForTests({} as unknown as AgentActivityRuntime);

    let draftContent = createDraft("hello");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
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
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("mock-paste-large-text"));

    expect(agentComposerDraftPrompt(draftContent)).toBe("hello");
    expect(agentComposerDraftLargeTexts(draftContent)[0]).toMatchObject({
      text: "first pasted line\nsecond pasted line",
      uploading: false,
      uploadError: expect.any(String)
    });
  });

  it("does not upload pasted large text when attachment upload is disabled", () => {
    const stagePastedText = vi.fn();
    setAgentActivityRuntimeForTests({
      stagePastedText
    } as unknown as AgentActivityRuntime);

    let draftContent = createDraft("hello");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
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
        canUploadAttachment={false}
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
    );

    fireEvent.click(screen.getByTestId("mock-paste-large-text"));

    expect(stagePastedText).not.toHaveBeenCalled();
    expect(agentComposerDraftPrompt(draftContent)).toBe("hello");
    expect(agentComposerDraftLargeTexts(draftContent)[0]).toMatchObject({
      text: "first pasted line\nsecond pasted line",
      uploading: false,
      uploadError: expect.any(String)
    });
  });

  it("lands pasted large text as a file and submits a pasted-text file block", async () => {
    type UploadResult = AgentActivityRuntimeStagePastedTextResult;
    let resolveUpload: (result: UploadResult) => void = () => undefined;
    const stagePastedText = vi.fn(
      () =>
        new Promise<UploadResult>((resolve) => {
          resolveUpload = resolve;
        })
    );
    setAgentActivityRuntimeForTests({
      stagePastedText
    } as unknown as AgentActivityRuntime);

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
    const { rerender } = render(renderComposer());

    fireEvent.click(screen.getByTestId("mock-paste-large-text"));

    // Phase 1: stages raw pasted text through the dedicated host contract.
    expect(stagePastedText).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      text: "first pasted line\nsecond pasted line",
      name: "pasted-text.txt"
    });
    expect(agentComposerDraftLargeTexts(draftContent)?.[0]).toMatchObject({
      text: "first pasted line\nsecond pasted line",
      uploading: true
    });
    expect(agentComposerDraftLargeTexts(draftContent)?.[0]?.id).toEqual(
      expect.any(String)
    );

    // Phase 2: uploading → spinner shown, submit blocked.
    rerender(renderComposer());
    expect(
      screen.getByTestId("agent-gui-composer-large-text-upload-spinner")
    ).toBeInTheDocument();
    // Codex-style chip: first-chars preview + "pasted text" subtitle.
    const largeTextChip = screen.getByTestId(
      "agent-gui-composer-large-text-draft"
    );
    expect(largeTextChip).toHaveTextContent("first past…");
    expect(largeTextChip).toHaveTextContent("Pasted text");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

    // Phase 3: upload resolves → path filled, uploading cleared.
    resolveUpload({
      path: "/archive/aa/deadbeef.txt",
      name: "pasted-text.txt",
      sizeBytes: 36
    });
    await waitFor(() =>
      expect(agentComposerDraftLargeTexts(draftContent)?.[0]).toMatchObject({
        path: "/archive/aa/deadbeef.txt",
        uploading: false
      })
    );
    rerender(renderComposer());

    const sendButton = screen.getByRole("button", { name: "发送" });
    expect(sendButton).not.toBeDisabled();
    fireEvent.click(sendButton);

    // Submit carries a structured pasted-text file block — no inlined body and
    // no instruction copy (the instruction is injected later, at send time).
    // The display prompt encodes a pasted-text mention link carrying the landed
    // path + size (the entity id is a per-paste random uuid).
    expect(onSubmit).toHaveBeenCalledWith(
      [
        {
          type: "file",
          kind: "pasted-text",
          path: "/archive/aa/deadbeef.txt",
          name: "first past…",
          sizeBytes: 36
        }
      ],
      expect.stringMatching(
        /^\[@[^\]]+\]\(mention:\/\/pasted-text\/[0-9a-f-]+\?path=%2Farchive%2Faa%2Fdeadbeef\.txt&size=36\)$/
      )
    );
  });

  it("restores a pasted-text chip back into the composer as inline text", async () => {
    type UploadResult = AgentActivityRuntimeStagePastedTextResult;
    let resolveUpload: (result: UploadResult) => void = () => undefined;
    const stagePastedText = vi.fn(
      () =>
        new Promise<UploadResult>((resolve) => {
          resolveUpload = resolve;
        })
    );
    setAgentActivityRuntimeForTests({
      stagePastedText
    } as unknown as AgentActivityRuntime);

    let draftContent = createDraft("hello");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
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
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );
    const { rerender } = render(renderComposer());

    fireEvent.click(screen.getByTestId("mock-paste-large-text"));
    resolveUpload({
      path: "/archive/aa/deadbeef.txt",
      name: "pasted-text.txt",
      sizeBytes: 36
    });
    await waitFor(() =>
      expect(agentComposerDraftLargeTexts(draftContent)?.[0]).toMatchObject({
        uploading: false
      })
    );
    rerender(renderComposer());

    // "Show in text field" dissolves the chip back into the prompt.
    fireEvent.click(screen.getByRole("button", { name: "Show in text field" }));

    expect(agentComposerDraftPrompt(draftContent)).toBe(
      "hello\nfirst pasted line\nsecond pasted line"
    );
    expect(agentComposerDraftLargeTexts(draftContent) ?? []).toEqual([]);
  });

  it("uploads pasted images immediately and submits the staged path", async () => {
    type UploadResult = AgentActivityRuntimeUploadPromptContentResult;
    let resolveUpload: (result: UploadResult) => void = () => undefined;
    const uploadPromptContent = vi.fn(
      () =>
        new Promise<UploadResult>((resolve) => {
          resolveUpload = resolve;
        })
    );
    setAgentActivityRuntimeForTests({
      uploadPromptContent
    } as unknown as AgentActivityRuntime);

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
    const { rerender } = render(renderComposer());

    fireEvent.click(screen.getByTestId("mock-paste-image"));

    expect(uploadPromptContent).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      content: [
        {
          type: "image",
          mimeType: "image/png",
          data: "aW1hZ2U=",
          name: "screen.png"
        }
      ]
    });
    expect(agentComposerDraftImages(draftContent)[0]).toMatchObject({
      data: "aW1hZ2U=",
      uploading: true
    });
    rerender(renderComposer());
    expect(
      screen.getByTestId("agent-gui-composer-image-upload-spinner")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

    resolveUpload({
      content: [
        {
          type: "image",
          mimeType: "image/png",
          path: "/var/cache/tsh/local-assets/workspace-1/screen.png",
          name: "screen.png"
        }
      ]
    });
    await waitFor(() =>
      expect(agentComposerDraftImages(draftContent)[0]).toMatchObject({
        path: "/var/cache/tsh/local-assets/workspace-1/screen.png",
        uploading: false
      })
    );
    rerender(renderComposer());

    const sendButton = screen.getByRole("button", { name: "发送" });
    expect(sendButton).not.toBeDisabled();
    fireEvent.click(sendButton);
    expect(onSubmit).toHaveBeenCalledWith([
      {
        type: "image",
        mimeType: "image/png",
        path: "/var/cache/tsh/local-assets/workspace-1/screen.png",
        name: "screen.png"
      }
    ]);
  });

  it("accepts URL-only image uploads and submits the remote URL", async () => {
    type UploadResult = AgentActivityRuntimeUploadPromptContentResult;
    let resolveUpload: (result: UploadResult) => void = () => undefined;
    const uploadPromptContent = vi.fn(
      () =>
        new Promise<UploadResult>((resolve) => {
          resolveUpload = resolve;
        })
    );
    const createSession = vi.fn();
    const sendInput = vi.fn();
    const reportDiagnostic = vi.fn();
    setAgentActivityRuntimeForTests({
      uploadPromptContent,
      createSession,
      sendInput,
      reportDiagnostic
    } as unknown as AgentActivityRuntime);

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
    const { rerender } = render(renderComposer());

    fireEvent.click(screen.getByTestId("mock-paste-image"));
    rerender(renderComposer());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    const uploadingSendButton = screen.getByRole("button", { name: "发送" });
    expect(uploadingSendButton).toBeDisabled();
    expect(uploadingSendButton).toHaveAttribute(
      "data-disabled-reason",
      "image_uploading"
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();

    resolveUpload({
      content: [
        {
          type: "image",
          mimeType: "image/png",
          url: "  https://objects.example.test/signed/screen.png  ",
          name: "screen.png"
        }
      ]
    });
    await waitFor(() =>
      expect(agentComposerDraftImages(draftContent)[0]).toMatchObject({
        url: "https://objects.example.test/signed/screen.png",
        previewUrl: "data:image/png;base64,aW1hZ2U=",
        uploading: false
      })
    );
    expect(agentComposerDraftImages(draftContent)[0]?.data).toBeUndefined();
    expect(
      agentComposerDraftImages(draftContent)[0]?.uploadError
    ).toBeUndefined();
    expect(reportDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.gui.composer.image_upload.requested",
        details: expect.objectContaining({ uploadFunctionAvailable: true })
      })
    );
    expect(reportDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.gui.composer.image_upload.resolved",
        details: expect.objectContaining({
          hasData: false,
          hasUrl: true
        })
      })
    );
    rerender(renderComposer());

    const sendButton = screen.getByRole("button", { name: "发送" });
    expect(sendButton).not.toBeDisabled();
    expect(sendButton).not.toHaveAttribute("data-disabled-reason");
    fireEvent.click(sendButton);
    expect(onSubmit).toHaveBeenCalledWith([
      {
        type: "image",
        mimeType: "image/png",
        url: "https://objects.example.test/signed/screen.png",
        name: "screen.png"
      }
    ]);
  });

  it("finishes image uploads in the draft scope where they started", async () => {
    type UploadResult = AgentActivityRuntimeUploadPromptContentResult;
    let resolveUpload: (result: UploadResult) => void = () => undefined;
    const uploadPromptContent = vi.fn(
      () =>
        new Promise<UploadResult>((resolve) => {
          resolveUpload = resolve;
        })
    );
    setAgentActivityRuntimeForTests({
      uploadPromptContent
    } as unknown as AgentActivityRuntime);

    const projectA = "project:/workspace/a";
    const projectB = "project:/workspace/b";
    let currentScopeKey = projectA;
    const drafts: Record<string, AgentComposerDraft> = {
      [projectA]: createDraft("project a"),
      [projectB]: createDraft("project b")
    };
    const onDraftContentChange = vi.fn(
      (nextDraft: AgentComposerDraft, sourceScopeKey?: string) => {
        drafts[sourceScopeKey ?? currentScopeKey] = nextDraft;
      }
    );
    const renderComposer = () => (
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={drafts[currentScopeKey]!}
        draftScopeKey={currentScopeKey}
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
        onSubmit={vi.fn()}
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
    expect(agentComposerDraftImages(drafts[projectA]!)[0]).toMatchObject({
      uploading: true
    });

    currentScopeKey = projectB;
    rerender(renderComposer());
    resolveUpload({
      content: [
        {
          type: "image",
          mimeType: "image/png",
          path: "/var/cache/tsh/local-assets/workspace-1/screen.png",
          name: "screen.png"
        }
      ]
    });

    await waitFor(() =>
      expect(agentComposerDraftImages(drafts[projectA]!)[0]).toMatchObject({
        uploading: false,
        path: "/var/cache/tsh/local-assets/workspace-1/screen.png"
      })
    );
    expect(drafts[projectB]).toEqual(createDraft("project b"));
    expect(onDraftContentChange).toHaveBeenLastCalledWith(
      drafts[projectA],
      projectA
    );
  });

  it("uses the development console diagnostic sink even when the upload runtime has a reporter", async () => {
    vi.stubEnv("AGENT_GUI_DEV_DIAGNOSTIC_CONSOLE", "1");
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const uploadPromptContent = vi.fn(async () => ({
      content: [
        {
          type: "image" as const,
          mimeType: "image/png" as const,
          url: "https://objects.example.test/signed/screen.png",
          name: "screen.png"
        }
      ]
    }));
    setAgentActivityRuntimeForTests({
      uploadPromptContent,
      reportDiagnostic: vi.fn()
    } as unknown as AgentActivityRuntime);

    let draftContent = createDraft("");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
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
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );
    const { rerender } = render(renderComposer());

    fireEvent.click(screen.getByTestId("mock-paste-image"));
    await waitFor(() =>
      expect(agentComposerDraftImages(draftContent)[0]).toMatchObject({
        url: "https://objects.example.test/signed/screen.png",
        uploading: false
      })
    );
    rerender(renderComposer());

    expect(
      consoleInfo.mock.calls.some(([prefix, serializedPayload]) => {
        const payload = JSON.parse(String(serializedPayload));
        return (
          prefix === "[agent-gui]" &&
          payload?.event === "agent.gui.composer.image_upload.resolved" &&
          payload?.details?.hasUrl === true
        );
      })
    ).toBe(true);
    expect(
      consoleInfo.mock.calls.some(([prefix, serializedPayload]) => {
        const payload = JSON.parse(String(serializedPayload));
        return (
          prefix === "[agent-gui]" &&
          payload?.event === "agent.gui.composer.submit_state_changed" &&
          payload?.details?.sendDisabledReason === null
        );
      })
    ).toBe(true);
  });

  it("marks uploaded images without usable references as failed", async () => {
    const uploadPromptContent = vi.fn(async () => ({
      content: [
        {
          type: "image" as const,
          mimeType: "image/png" as const,
          name: "screen.png"
        }
      ]
    }));
    setAgentActivityRuntimeForTests({
      uploadPromptContent
    } as unknown as AgentActivityRuntime);

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
    const { rerender } = render(renderComposer());

    fireEvent.click(screen.getByTestId("mock-paste-image"));

    await waitFor(() =>
      expect(agentComposerDraftImages(draftContent)[0]).toMatchObject({
        uploading: false,
        uploadError:
          "Prompt image upload completed without usable image reference."
      })
    );
    rerender(renderComposer());

    expect(
      screen.getByTestId("agent-gui-composer-image-draft")
    ).toHaveAttribute("data-upload-error", "true");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("uploads host-local references before inserting file mention anchors", async () => {
    type UploadResult = AgentActivityRuntimeUploadPromptContentResult;
    let resolveUpload: (result: UploadResult) => void = () => undefined;
    const uploadPromptContent = vi.fn(
      () =>
        new Promise<UploadResult>((resolve) => {
          resolveUpload = resolve;
        })
    );
    setAgentActivityRuntimeForTests({
      uploadPromptContent
    } as unknown as AgentActivityRuntime);

    let draftContent = createDraft("看下这张图");
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
        onRequestWorkspaceReferences={async () => ({
          files: [
            {
              path: "f37ec5e4-bbf2-49a2-90a9-d2b9d42e9b91",
              hostPath: "/Users/vector/Downloads/首页 (1).jpg",
              displayName: "首页 (1).jpg",
              kind: "file",
              sourceId: "host-local-file"
            }
          ],
          mentionItems: []
        })}
      />
    );
    const { container, rerender } = render(renderComposer());

    fireEvent.click(screen.getByRole("combobox", { name: "引用空间文件" }));
    await waitFor(() =>
      expect(uploadPromptContent).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        content: [
          {
            type: "file",
            hostPath: "/Users/vector/Downloads/首页 (1).jpg",
            name: "首页 (1).jpg",
            kind: "file"
          }
        ]
      })
    );
    resolveUpload({
      content: [
        {
          type: "file",
          path: "/var/cache/tsh/local-assets/workspace-1/user-1/home.jpg",
          name: "首页 (1).jpg",
          kind: "file"
        }
      ]
    });
    await waitFor(() =>
      expect(agentComposerDraftPrompt(draftContent)).toBe(
        "看下这张图[@首页 (1).jpg](/var/cache/tsh/local-assets/workspace-1/user-1/home.jpg) "
      )
    );
    expect(agentComposerDraftPrompt(draftContent)).not.toContain(
      "f37ec5e4-bbf2-49a2-90a9-d2b9d42e9b91"
    );
    rerender(renderComposer());

    fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledWith([
      {
        type: "text",
        text: "看下这张图[@首页 (1).jpg](/var/cache/tsh/local-assets/workspace-1/user-1/home.jpg)"
      }
    ]);
  });

  it("removes the active @ trigger before inserting references opened from a mention row", async () => {
    let draftContent = createDraft("@");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
    const onRequestWorkspaceReferences = vi.fn(async () => ({
      files: [],
      mentionItems: [
        {
          kind: "workspace-reference" as const,
          href: "mention://workspace-reference/topic-1?groupId=issue-1&source=task&workspaceId=workspace-1",
          workspaceId: "workspace-1",
          targetId: "topic-1",
          source: "task" as const,
          groupId: "issue-1",
          name: "制作一个1000字小说",
          fileCount: 2
        }
      ]
    }));

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
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
        onRequestWorkspaceReferences={onRequestWorkspaceReferences}
      />
    );

    fireEvent.click(await screen.findByTestId("mock-open-references"));

    await waitFor(() =>
      expect(agentComposerDraftPrompt(draftContent)).toBe(
        "[@制作一个1000字小说](mention://workspace-reference/topic-1?groupId=issue-1&source=task&workspaceId=workspace-1) "
      )
    );
    expect(agentComposerDraftPrompt(draftContent)).not.toMatch(/^@/);
  });

  it("keeps the active @ trigger after canceling references from a mention row", async () => {
    let draftContent = createDraft("@");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
    const onRequestWorkspaceReferences = vi.fn(async () => ({
      files: [],
      mentionItems: []
    }));

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
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
        onRequestWorkspaceReferences={onRequestWorkspaceReferences}
      />
    );

    fireEvent.click(await screen.findByTestId("mock-open-references"));

    await waitFor(() =>
      expect(onRequestWorkspaceReferences).toHaveBeenCalled()
    );
    expect(agentComposerDraftPrompt(draftContent)).toBe("@");
    expect(screen.getByTestId("mock-open-references")).toBeInTheDocument();
  });

  it("lets the reference picker own Escape while the mention palette stays open", async () => {
    let draftContent = createDraft("@");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });

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
        workspaceReferencePickerOpen
        workspaceUserProjectI18n={workspaceUserProjectI18n}
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
        onRequestWorkspaceReferences={vi.fn()}
      />
    );

    fireEvent.keyDown(screen.getByPlaceholderText("placeholder"), {
      key: "Escape"
    });

    expect(agentComposerDraftPrompt(draftContent)).toBe("@");
    expect(onDraftContentChange).not.toHaveBeenCalled();
  });

  it("cancels an empty-result @ search on Enter instead of sending, then sends on the next Enter", () => {
    // A non-empty query (rather than a bare "@") puts the mention search in
    // "results" mode, matching the reported scenario: the user typed @ plus
    // some text and the search resolved to zero matches. No providers are
    // wired up in this test, so it deterministically has no results.
    let draftContent = createDraft("@doesnotexist12345");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
    const onSubmit = vi.fn();

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

    const textbox = screen.getByPlaceholderText("placeholder");

    // The first Enter should dismiss the empty panel rather than send — the
    // typed "@doesnotexist12345" text stays untouched.
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(agentComposerDraftPrompt(draftContent)).toBe("@doesnotexist12345");

    // With the search cancelled, the next Enter behaves as if there were no
    // active @ context and sends the message normally.
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalled();
  });

  it("opens the mention palette from the @ footer button", async () => {
    let draftContent = createDraft("");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });

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
        onDraftContentChange={onDraftContentChange}
        onSettingsChange={vi.fn()}
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "提及上下文" }));

    await waitFor(() =>
      expect(agentComposerDraftPrompt(draftContent)).toBe("@")
    );
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

  it("opens a zoom preview for pasted image drafts", async () => {
    let draftContent = createDraft("");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
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
        onSubmit={vi.fn()}
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

    fireEvent.click(screen.getByRole("img", { name: "screen.png" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("removes pasted image drafts without opening the zoom preview", async () => {
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight"
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        if (!(this instanceof HTMLElement)) {
          return 24;
        }
        if (
          this.classList.contains("agent-gui-node__composer-prompt-input-area")
        ) {
          return this.querySelector(
            '[data-testid="agent-gui-composer-image-drafts"]'
          )
            ? 204
            : 54;
        }
        return this.matches('[data-testid="agent-gui-composer-image-drafts"]')
          ? 56
          : 24;
      }
    });
    let draftContent = createDraft("");
    const onDraftContentChange = vi.fn((nextDraft: AgentComposerDraft) => {
      draftContent = nextDraft;
    });
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
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );
    try {
      const { rerender } = render(renderComposer());

      fireEvent.click(screen.getByTestId("mock-paste-image"));
      rerender(renderComposer());
      await waitFor(() =>
        expect(
          screen.getByTestId("agent-gui-composer-image-drafts").parentElement
        ).toHaveStyle({
          "--agent-gui-composer-attachment-height": "56px",
          "--agent-gui-composer-input-height": "190px",
          "--agent-gui-composer-input-max-height": "190px"
        })
      );

      const drafts = screen.getByTestId("agent-gui-composer-image-drafts");
      const removeButton = within(drafts).getByRole("button", {
        name: "移除引用"
      });
      expect(removeButton).toHaveClass("z-[2]");
      fireEvent.click(removeButton);
      rerender(renderComposer());

      expect(
        screen.queryByTestId("agent-gui-composer-image-drafts")
      ).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen
            .getByPlaceholderText("placeholder")
            .closest(".agent-gui-node__composer-prompt-input-area")
        ).toHaveStyle({
          "--agent-gui-composer-input-height": "56px"
        })
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
      if (scrollHeightDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollHeight",
          scrollHeightDescriptor
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      }
    }
  });

  it("keeps pasted image drafts until the engine acknowledges submitting", () => {
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

    onDraftContentChange.mockClear();
    fireEvent.submit(container.querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledWith([
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
        name: "screen.png"
      }
    ]);

    rerender(renderComposer(false));
    expect(
      screen.getByTestId("agent-gui-composer-image-drafts")
    ).toBeInTheDocument();
    expect(onDraftContentChange).not.toHaveBeenCalled();
    draftContent = createDraft("");
    rerender(renderComposer(true));
    expect(
      screen.queryByTestId("agent-gui-composer-image-drafts")
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

  it.each(["codex", "claude-code", "opencode"] as const)(
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
      expect(
        screen.getByTestId("agent-gui-command-menu-surface")
      ).toContainElement(screen.getByTestId("agent-gui-review-picker-panel"));
      expect(onSubmit).not.toHaveBeenCalled();

      // Selecting the "uncommitted changes" scope submits an explicit target.
      fireEvent.click(screen.getByText("未提交的更改"));
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0]?.[0]).toEqual([
        { type: "text", text: "/review uncommitted" }
      ]);
    }
  );

  it("lets the review picker handle staged Escape before closing", () => {
    const { container } = render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        slashStatus={{ agentSessionId: "agent-session-1", limits: [] }}
        draftContent={createDraft("/review")}
        availableCommands={
          [{ name: "review" }] satisfies readonly AgentHostAgentSessionCommand[]
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
        onSubmit={vi.fn()}
        onSendQueuedPromptNext={vi.fn()}
        onRemoveQueuedPrompt={vi.fn()}
        onEditQueuedPrompt={vi.fn()}
        onInterruptCurrentTurn={vi.fn()}
        onSubmitInteractivePrompt={vi.fn()}
      />
    );

    fireEvent.submit(container.querySelector("form")!);
    fireEvent.click(screen.getByText("与分支比较"));
    const branchSearch = screen.getByPlaceholderText("选择分支");

    fireEvent.keyDown(branchSearch, { key: "Escape" });

    expect(screen.getByText("未提交的更改")).toBeInTheDocument();
    const rootSearch = screen.getByPlaceholderText("搜索");

    fireEvent.keyDown(rootSearch, { key: "Escape" });

    expect(
      screen.queryByTestId("agent-gui-review-picker-panel")
    ).not.toBeInTheDocument();
  });

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
    slashCommandPolicy: {
      fallbackCommands: ["compact", "status", "fast", "goal", "review"],
      commandEffects: [
        { command: "init", effect: "submitImmediate" },
        { command: "compact", effect: "submitImmediate" },
        { command: "review", effect: "showReviewPicker" },
        { command: "goal", effect: "activateGoalMode" },
        { command: "plan", effect: "togglePlanMode" },
        { command: "status", effect: "showStatus" },
        { command: "fast", effect: "toggleSpeed" }
      ]
    },
    isSettingsLoading: false,
    modelUnavailable: false,
    reasoningUnavailable: false,
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
    modelContextWindowSuffix: "上下文窗口",
    modelTooltipVersionLabel: "版本",
    defaultModel: "默认模型",
    loadingOptions: "正在加载",
    inheritedUnavailable: "不可用",
    loadingConversation: "加载会话中",
    reasoningLabel: "推理",
    reasoningDegreeLabel: "推理强度",
    reasoningOptionDefault: "默认",
    reasoningOptionMinimal: "最少",
    reasoningOptionLow: "低",
    reasoningOptionMedium: "中",
    reasoningOptionHigh: "高",
    reasoningOptionXHigh: "超高",
    reasoningOptionMax: "最高",
    reasoningOptionUltra: "极致",
    speedLabel: "Speed",
    speedSelectionLabel: "Speed",
    speedOptionStandard: "Standard",
    speedOptionStandardDescription: "Standard speed",
    speedOptionFast: "Fast",
    speedOptionFastDescription: "1.5x speed",
    permissionLabel: "运行权限",
    permissionModeReadOnly: "请求批准",
    permissionModeAuto: "替我审批",
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
    goalLabel: "目标",
    browserUseCapabilityLabel: "浏览器",
    browserUseCapabilityDescription: "让 Agent 使用浏览器。",
    browserUseCapabilityDescriptionAutoConnect:
      "当前配置：复用已登录的 Chrome。",
    browserUseCapabilityDescriptionIsolated: "当前配置：使用独立浏览器。",
    browserUseCapabilitySettingsLabel: "浏览器设置",
    browserUseCapabilitySettingsDescription: "配置 Agent 使用的浏览器。",
    capabilityInlineSettingsLabel: "设置",
    computerUseCapabilityLabel: "电脑控制",
    computerUseCapabilityDescription: "让 Agent 控制 macOS 桌面。",
    computerUseCapabilitySetupRequiredDescription:
      "未安装。按 Enter 打开设置。",
    computerUseCapabilityAuthorizationRequiredDescription:
      "需要授权。按 Enter 打开设置。",
    computerUseCapabilityAuthorizationUnknownDescription:
      "无法确认授权状态。按 Enter 打开设置。",
    computerUseCapabilitySettingsLabel: "电脑控制设置",
    computerUseCapabilitySettingsDescription: "安装、移除或授权电脑控制。",
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
    slashPaletteCapabilitiesLoading: "能力加载中…",
    slashPaletteSkillsGroup: "技能",
    slashPalettePluginsGroup: "插件",
    slashPaletteConnectorsGroup: "连接器",
    slashPaletteMcpGroup: "MCP",
    slashCommandCompactLabel: "压缩",
    slashCommandContextLabel: "上下文",
    slashCommandFastLabel: "快速",
    slashCommandGoalLabel: "目标",
    slashCommandInitLabel: "初始化",
    slashCommandPlanLabel: "计划",
    slashCommandReviewLabel: "审查",
    slashCommandStatusLabel: "状态",
    slashCommandUsageLabel: "用量",
    slashCommandCompactDescription: "压缩当前对话上下文。",
    slashCommandContextDescription: "查看当前上下文快照。",
    slashCommandFastDescription: "切换快速响应模式。",
    slashCommandGoalDescription: "设置、查看或清除当前目标。",
    slashCommandInitDescription: "初始化仓库说明文件。",
    slashCommandPlanDescription: "切换计划模式。",
    slashCommandReviewDescription: "发起代码审查。",
    slashCommandStatusDescription: "查看会话状态和上下文用量。",
    slashCommandUsageDescription: "查看上下文和额度用量。",
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
    usageChipLabel: ({ percent }) => `上下文 ${percent}%`,
    usageTooltipLabel: "上下文用量",
    usagePopoverTitle: "上下文用量",
    usageContextWindowLabel: "上下文窗口",
    usageTokensLabel: "Token 用量",
    usageLimitsLabel: "限额",
    usageCompactAction: "压缩",
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
    fileDropHint: "拖放文件以添加到对话",
    mentionPalette: "提及上下文",
    removeMention: "移除引用",
    addReference: "添加引用",
    addContent: "添加文件等内容",
    referenceWorkspaceFiles: "引用空间文件",
    handoffConversation: "Handoff",
    handoffConversationTooltip: "交接给其他 Agent",
    handoffConversationMenu: "选择 Agent",
    providerSwitchLabel: "切换 Provider",
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
