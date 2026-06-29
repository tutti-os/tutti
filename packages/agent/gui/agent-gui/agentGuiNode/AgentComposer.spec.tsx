import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  type AgentActivityRuntimeUploadPromptContentResult
} from "../../agentActivityRuntime";
import type {
  AgentComposerDraft,
  AgentGUIComposerSettingsVM,
  AgentGUIQueuedPromptVM
} from "./model/agentGuiNodeTypes";
import type { AgentHostAgentSessionCommand } from "../../shared/contracts/dto";

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
  images: AgentComposerDraft["images"] = [],
  files: AgentComposerDraft["files"] = []
): AgentComposerDraft {
  return { prompt, images, files };
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
  Popover: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  PopoverAnchor: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  PopoverContent: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="agent-gui-usage-popover">{children}</div>
  )
}));

vi.mock("./agentRichText/AgentRichTextEditor", async () => {
  const React = await import("react");
  return {
    AgentRichTextEditor: React.forwardRef(
      (
        {
          disabled,
          onChange,
          onPasteImages,
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
              readOnly
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
            {entry.label}
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
        查看产物文件
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

  it("renders composer draft images with image actions", () => {
    render(
      <AgentComposer
        workspaceId="workspace-1"
        currentUserId="user-1"
        provider="codex"
        draftContent={createDraft("", [
          {
            id: "img-1",
            name: "earth.png",
            mimeType: "image/png",
            previewUrl: "blob:preview-1",
            uploading: false
          }
        ])}
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

    const drafts = screen.getByTestId("agent-gui-composer-image-drafts");
    expect(drafts).toHaveClass("w-full");
    expect(drafts.className).not.toContain("max-w-[320px]");
    expect(screen.getByRole("img", { name: "earth.png" })).toBeInTheDocument();
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
    expect(onDraftContentChange).toHaveBeenLastCalledWith({
      prompt: "",
      images: [],
      files: []
    });
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

  it("keeps the status panel styled as floating command menu content", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__slash-status-panel\s*{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*padding:\s*10px 12px/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-node__slash-status-panel\s*{[^}]*border-bottom:\s*0/s
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

  it("keeps the dock send control inside the input and settings below it", () => {
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

    const composer = container.querySelector(".agent-gui-node__composer");
    expect(composer).toHaveAttribute("data-layout", "dock");
    const footer = container.querySelector(".agent-gui-node__composer-footer");
    expect(footer).not.toBeNull();
    expect(footer?.lastElementChild?.className).toContain(
      "agent-gui-node__composer-footer-right"
    );
    const promptInputArea = container.querySelector(
      ".agent-gui-node__composer-prompt-input-area"
    );
    expect(promptInputArea).not.toBeNull();
    const sendButton = screen.getByRole("button", { name: "发送" });
    expect(promptInputArea?.contains(sendButton)).toBe(true);
    expect(footer?.contains(sendButton)).toBe(false);
    expect(promptInputArea?.contains(footer)).toBe(false);
    expect(footer?.compareDocumentPosition(promptInputArea!)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING
    );
    expect(screen.getByPlaceholderText("placeholder")).toHaveClass(
      "agent-gui-node__composer-textarea"
    );
  });

  it("expands the dock prompt input immediately for pasted image drafts", async () => {
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
          return 180;
        }
        return this.matches('[data-testid="agent-gui-composer-image-drafts"]')
          ? 56
          : 24;
      }
    });

    try {
      render(
        <AgentComposer
          workspaceId="workspace-1"
          currentUserId="user-1"
          provider="codex"
          draftContent={createDraft("", [
            {
              id: "image-1",
              name: "screen.png",
              mimeType: "image/png",
              previewUrl: "data:image/png;base64,aW1hZ2U="
            }
          ])}
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
      );

      await waitFor(() =>
        expect(
          screen.getByTestId("agent-gui-composer-image-drafts").parentElement
        ).toHaveStyle({
          "--agent-gui-composer-attachment-height": "56px",
          "--agent-gui-composer-input-height": "176px",
          "--agent-gui-composer-input-max-height": "176px"
        })
      );
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

  it("keeps footer action spacing and chevron slots consistent", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\]\s+\.agent-gui-node__composer-input-shell\s*{[^}]*padding:\s*0[^}]*border:\s*0[^}]*background:\s*transparent/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\]\s+\.agent-gui-node__composer-prompt-input-area\s*{[^}]*display:\s*grid[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)[^}]*height:\s*var\(--agent-gui-composer-input-height,\s*56px\)[^}]*min-height:\s*56px[^}]*max-height:\s*var\(--agent-gui-composer-input-max-height,\s*120px\)[^}]*align-items:\s*center[^}]*overflow:\s*hidden[^}]*padding:\s*0 12px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\]\s+\.agent-gui-node__composer-prompt-input-area\s*{[^}]*transition:[^}]*height\s+160ms\s+ease[^}]*border-color\s+140ms\s+ease[^}]*box-shadow\s+140ms\s+ease/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\]\s+\.agent-gui-node__composer-prompt-input-line\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto[^}]*align-items:\s*center[^}]*box-sizing:\s*border-box[^}]*height:\s*calc\(var\(--agent-gui-composer-text-height,\s*56px\)\s*-\s*2px\)[^}]*min-height:\s*54px[^}]*max-height:\s*118px[^}]*padding:\s*12px 0/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\]\s+\.agent-gui-node__composer-send-button\s*{[^}]*align-self:\s*end/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\][\s\S]*?\.agent-gui-node__composer-prompt-input-area\[data-has-draft-images="true"\]\s*{[^}]*grid-template-rows:[^}]*minmax\(0,\s*var\(--agent-gui-composer-attachment-height,\s*0px\)\)[^}]*minmax\(40px,\s*1fr\)[^}]*align-items:\s*stretch/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\][\s\S]*?\.agent-gui-node__composer-prompt-input-area\[data-has-draft-images="true"\][\s\S]*?\[data-testid="agent-gui-composer-image-drafts"\]\s*{[^}]*min-height:\s*0[^}]*margin-bottom:\s*0[^}]*overflow:\s*hidden/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\][\s\S]*?\.agent-gui-node__composer-prompt-input-area\[data-has-draft-images="true"\][\s\S]*?\[data-testid="agent-gui-composer-image-draft"\]\s*{[^}]*max-height:\s*56px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\][\s\S]*?\.agent-gui-node__composer-prompt-input-area\[data-has-draft-images="true"\][\s\S]*?\.agent-gui-node__composer-prompt-input-line\s*{[^}]*min-height:\s*40px[^}]*height:\s*calc\(var\(--agent-gui-composer-text-height,\s*56px\)\s*-\s*2px\)[^}]*max-height:\s*118px[^}]*padding:\s*4px 0 11px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\]\s+textarea,[\s\S]*?\.agent-gui-node__composer\[data-layout="dock"\]\s+\.agent-gui-node__composer-textarea\s*{[^}]*display:\s*block[^}]*height:\s*auto[^}]*min-height:\s*24px[^}]*max-height:\s*calc\(var\(--agent-gui-composer-text-height,\s*56px\)\s*-\s*26px\)[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto[^}]*overflow-wrap:\s*anywhere[^}]*scrollbar-width:\s*none[^}]*white-space:\s*pre-wrap/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\][\s\S]*?\.agent-gui-node__composer-prompt-input-area\[data-has-draft-images="true"\][\s\S]*?textarea,[\s\S]*?\.agent-gui-node__composer\[data-layout="dock"\][\s\S]*?\.agent-gui-node__composer-prompt-input-area\[data-has-draft-images="true"\][\s\S]*?\.agent-gui-node__composer-textarea\s*{[^}]*max-height:\s*calc\([^}]*var\(--agent-gui-composer-text-height,\s*56px\)[^}]*26px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\][\s\S]*?\.agent-gui-node__composer-prompt-input-area:hover[\s\S]*?\.agent-gui-node__composer-textarea,[\s\S]*?\.agent-gui-node__composer\[data-layout="dock"\][\s\S]*?\.agent-gui-node__composer-prompt-input-area:focus-within[\s\S]*?\.agent-gui-node__composer-textarea\s*{[^}]*scrollbar-width:\s*thin/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\]\s+textarea::-webkit-scrollbar,[\s\S]*?\.agent-gui-node__composer\[data-layout="dock"\s*\][\s\S]*?\.agent-gui-node__composer-textarea::-webkit-scrollbar\s*{[^}]*display:\s*none[^}]*width:\s*4px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\][\s\S]*?\.agent-gui-node__composer-prompt-input-area:hover[\s\S]*?::-webkit-scrollbar,[\s\S]*?\.agent-gui-node__composer\[data-layout="dock"\][\s\S]*?\.agent-gui-node__composer-prompt-input-area:focus-within[\s\S]*?::-webkit-scrollbar\s*{[^}]*display:\s*block/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\]\s+\.agent-gui-node__composer-textarea\s+p\s*{[^}]*display:\s*block[^}]*width:\s*auto[^}]*min-width:\s*0[^}]*overflow:\s*visible[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*pre-wrap/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\][\s\S]*?\.agent-rich-text-placeholder-node:first-child\s*{[^}]*position:\s*relative[^}]*display:\s*block[^}]*min-height:\s*24px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\][\s\S]*?\.agent-rich-text-placeholder-node:first-child::before\s*{[^}]*position:\s*absolute[^}]*top:\s*0[^}]*left:\s*0[^}]*float:\s*none[^}]*height:\s*24px[^}]*line-height:\s*24px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-footer-right\s*{[^}]*gap:\s*2px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-footer-right\s+\.agent-gui-node__composer-menu-trigger\s+>\s+svg\s*{[^}]*width:\s*16px[^}]*height:\s*16px[^}]*flex:\s*0 0 16px[^}]*margin-left:\s*0/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-menu-trigger\s*{[^}]*padding:\s*0 8px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-reference-trigger\s*{[^}]*min-width:\s*36px;[^}]*min-height:\s*36px;[^}]*padding:\s*0;/s
    );
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
    expect(screen.getByTestId("agent-gui-usage-popover")).toBeVisible();
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

    // Open the usage popover before asserting/clicking the compact button
    const usageChip = screen.getByTestId("agent-gui-usage-chip");
    fireEvent.click(usageChip);

    const compactButton = screen.queryByTestId("agent-gui-compact-button");
    expect(compactButton).toBeInTheDocument();
    expect(compactButton).toHaveClass("hover:bg-[var(--transparency-hover)]");
    fireEvent.click(compactButton!);
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

  it("shows the compact context button disabled while busy (showStopButton=true)", () => {
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

    fireEvent.click(screen.getByTestId("agent-gui-usage-chip"));
    const compactButton = screen.getByTestId("agent-gui-compact-button");
    expect(compactButton).toBeInTheDocument();
    expect(compactButton).toBeDisabled();
    fireEvent.click(compactButton);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the compact context button disabled when no user message has been sent", () => {
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

    fireEvent.click(screen.getByTestId("agent-gui-usage-chip"));
    const compactButton = screen.getByTestId("agent-gui-compact-button");
    expect(compactButton).toBeDisabled();
    fireEvent.click(compactButton);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the compact context button disabled when the composer is blocked (read-only)", () => {
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

    fireEvent.click(screen.getByTestId("agent-gui-usage-chip"));
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
    expect(footerLeft?.firstElementChild).toBe(referenceDropdown);
    expect(referenceDropdown).toHaveAttribute("data-slot", "select-trigger");
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
    expect(draftContent.images[0]).toMatchObject({
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
          path: "/var/cache/tsh/local-assets/workspace-1/user-1/screen.png",
          name: "screen.png"
        }
      ]
    });
    await waitFor(() =>
      expect(draftContent.images[0]).toMatchObject({
        path: "/var/cache/tsh/local-assets/workspace-1/user-1/screen.png",
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
        path: "/var/cache/tsh/local-assets/workspace-1/user-1/screen.png",
        name: "screen.png"
      }
    ]);
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
      expect(draftContent.prompt).toBe(
        "看下这张图[@首页 (1).jpg](/var/cache/tsh/local-assets/workspace-1/user-1/home.jpg) "
      )
    );
    expect(draftContent.prompt).not.toContain(
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
      expect(draftContent.prompt).toBe(
        "[@制作一个1000字小说](mention://workspace-reference/topic-1?groupId=issue-1&source=task&workspaceId=workspace-1) "
      )
    );
    expect(draftContent.prompt).not.toMatch(/^@/);
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

    expect(screen.getByRole("img", { name: "screen.png" })).toHaveClass(
      "cursor-zoom-in",
      "size-full",
      "object-contain"
    );
    fireEvent.click(screen.getByRole("img", { name: "screen.png" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("sizes pasted image drafts from the loaded image aspect ratio", async () => {
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
    await waitFor(() => expect(mockEditorFocusAtEnd).toHaveBeenCalled());
    rerender(renderComposer());

    const image = screen.getByRole("img", {
      name: "screen.png"
    }) as HTMLImageElement;
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 320
    });
    Object.defineProperty(image, "naturalHeight", {
      configurable: true,
      value: 160
    });
    fireEvent.load(image);

    await waitFor(() => {
      expect(screen.getByTestId("agent-gui-composer-image-draft")).toHaveStyle({
        aspectRatio: "2",
        width: "144px"
      });
    });
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
            ? 180
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
          "--agent-gui-composer-input-height": "176px",
          "--agent-gui-composer-input-max-height": "176px"
        })
      );

      const drafts = screen.getByTestId("agent-gui-composer-image-drafts");
      fireEvent.click(within(drafts).getByRole("button", { name: "移除引用" }));
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

  it("clears pasted image drafts immediately after submitting", () => {
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

    rerender(renderComposer(false));
    expect(
      screen.queryByTestId("agent-gui-composer-image-drafts")
    ).not.toBeInTheDocument();
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
      expect(
        screen.getByTestId("agent-gui-command-menu-surface")
      ).toContainElement(screen.getByTestId("agent-gui-review-picker-panel"));
      expect(onSubmit).not.toHaveBeenCalled();

      // Selecting the "uncommitted changes" scope submits a bare /review.
      fireEvent.click(screen.getByText("未提交的更改"));
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0]?.[0]).toEqual([
        { type: "text", text: "/review" }
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
    slashPaletteSkillsGroup: "技能",
    slashPalettePluginsGroup: "插件",
    slashPaletteConnectorsGroup: "连接器",
    slashPaletteMcpGroup: "MCP",
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
    usagePopoverTitle: "用量",
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
