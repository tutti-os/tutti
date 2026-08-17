import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { createRichTextMentionService } from "@tutti-os/ui-rich-text/service";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentGUIQuickComposer } from "./AgentGUIQuickComposer";
import type { AgentGUIQuickComposerAgentTarget } from "./AgentGUIQuickComposer";
import { agentGuiI18nResources } from "./i18n/index";
import { projectQuickComposerSettings } from "./quickComposerSettings";

const agentTargets = [
  {
    agentTargetId: "agent:codex",
    iconUrl: "/codex.png",
    label: "Codex",
    provider: "codex"
  }
] satisfies AgentGUIQuickComposerAgentTarget[];

const capabilitiesByAgentTargetId = {
  "agent:codex": { imageInput: true, workspaceReferences: true }
} as const;

const composerOptions = {
  behavior: {
    collapseModelOptionsToLatest: false,
    modelOptionsAuthoritative: true,
    planModeExclusiveWithPermissionMode: false,
    prewarmDraftSession: false,
    refreshModelOptionsAfterSettings: true
  },
  capabilities: null,
  effectiveSettings: {
    model: "gpt-5.6-sol",
    reasoningEffort: "high"
  },
  loadedAtUnixMs: 1,
  modelConfigurable: true,
  models: [
    { label: "GPT-5.6-Sol", value: "gpt-5.6-sol" },
    { label: "GPT-5.5", value: "gpt-5.5" }
  ],
  provider: "codex",
  reasoningConfigurable: true,
  reasoningEfforts: [
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" }
  ],
  skills: [],
  speeds: []
} satisfies AgentActivityComposerOptions;

beforeEach(() => {
  globalThis.localStorage.clear();
});

describe("AgentGUIQuickComposer", () => {
  it("fails closed when the controlled Agent target is missing or disabled", () => {
    const { container, rerender } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        content={[{ text: "Inspect this", type: "text" }]}
        selectedAgentTargetId="agent:missing"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-gui-composer-send"]'
      )?.disabled
    ).toBe(true);

    rerender(
      <AgentGUIQuickComposer
        agentTargets={[{ ...agentTargets[0]!, disabled: true }]}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        content={[{ text: "Inspect this", type: "text" }]}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-gui-composer-send"]'
      )?.disabled
    ).toBe(true);
  });

  it("submits the exact resolved Agent target identity", () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        content={[{ text: "Inspect this", type: "text" }]}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-gui-composer-send"]'
      )!
    );

    expect(onSubmit).toHaveBeenCalledWith({
      agentTargetId: "agent:codex",
      content: [{ text: "Inspect this", type: "text" }],
      displayPrompt: "Inspect this"
    });
  });

  it("reuses the standard model and reasoning controls", async () => {
    const onSettingsChange = vi.fn();
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        composerSettings={{
          loading: false,
          onChange: onSettingsChange,
          options: composerOptions,
          value: { model: "gpt-5.6-sol", reasoningEffort: "high" }
        }}
        content={[{ text: "Inspect this", type: "text" }]}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-agent-model-reasoning-trigger="true"]'
    );
    expect(trigger).toHaveTextContent("GPT-5.6-Sol");
    expect(trigger).toHaveTextContent("High");

    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false });
    await waitFor(() =>
      expect(
        document.querySelector('[data-agent-model-value="gpt-5.5"]')
      ).not.toBeNull()
    );
    fireEvent.pointerDown(
      document.querySelector<HTMLElement>(
        '[data-agent-model-value="gpt-5.5"]'
      )!,
      { button: 0 }
    );

    expect(onSettingsChange).toHaveBeenCalledWith({ model: "gpt-5.5" });
    expect(
      globalThis.localStorage.getItem(
        "agent-gui:composer-model-recents:agent:codex"
      )
    ).toBe('["gpt-5.5"]');
    expect(
      globalThis.localStorage.getItem(
        "agent-gui:composer-model-recents:default"
      )
    ).toBeNull();
  });

  it("migrates legacy model history into the exact selected target", async () => {
    globalThis.localStorage.setItem(
      "agent-gui:composer-model-recents:default",
      '["obsolete-model","gpt-5.5"]'
    );
    globalThis.localStorage.setItem(
      "agent-gui:composer-model-favorites:default",
      '["gpt-5.5"]'
    );
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        composerSettings={{
          loading: false,
          onChange: vi.fn(),
          options: composerOptions,
          value: { model: "gpt-5.6-sol", reasoningEffort: "high" }
        }}
        content={[{ text: "Inspect this", type: "text" }]}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    fireEvent.pointerDown(
      container.querySelector<HTMLButtonElement>(
        '[data-agent-model-reasoning-trigger="true"]'
      )!,
      { button: 0, ctrlKey: false }
    );

    await waitFor(() => {
      expect(
        globalThis.localStorage.getItem(
          "agent-gui:composer-model-recents:agent:codex"
        )
      ).toBe('["gpt-5.5"]');
      expect(
        globalThis.localStorage.getItem(
          "agent-gui:composer-model-favorites:agent:codex"
        )
      ).toBe('["gpt-5.5"]');
    });
    expect(
      globalThis.localStorage.getItem(
        "agent-gui:composer-model-recents:default"
      )
    ).toBeNull();
    expect(
      globalThis.localStorage.getItem(
        "agent-gui:composer-model-favorites:default"
      )
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-agent-model-value="gpt-5.5"] [data-agent-model-favorite-toggle="true"]'
      )
    ).toHaveAttribute("data-favorited", "true");
  });

  it("marks retained catalog testimony unsettled while the host is loading", () => {
    const projected = projectQuickComposerSettings({
      agentTargetId: "agent:codex",
      loading: true,
      options: composerOptions,
      projectLocked: false,
      provider: "codex",
      selectedProjectPath: null,
      settings: {}
    });

    expect(projected.modelChoiceHistory).toEqual({
      targetId: "agent:codex",
      catalog: {
        authoritative: true,
        effectiveModel: "gpt-5.6-sol",
        loading: true,
        models: [{ value: "gpt-5.6-sol" }, { value: "gpt-5.5" }]
      }
    });
  });

  it("keeps prompt entry and references available while options load", () => {
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        composerSettings={{
          loading: true,
          onChange: vi.fn(),
          options: null,
          value: {}
        }}
        content={[{ text: "Inspect this", type: "text" }]}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onRequestWorkspaceReferences={vi.fn().mockResolvedValue({
          files: [],
          mentionItems: []
        })}
        onSubmit={vi.fn()}
      />
    );

    expect(
      container.querySelector<HTMLElement>('[role="textbox"]')
    ).toHaveAttribute("aria-disabled", "false");
    expect(
      container
        .querySelector('[data-agent-reference-add-icon="true"]')
        ?.closest("button")
    ).not.toBeDisabled();
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-agent-model-reasoning-trigger="true"]'
      )
    ).toBeDisabled();
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-gui-composer-send"]'
      )
    ).toBeDisabled();
  });

  it("hides settings controls when the host omits the controlled capability", () => {
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        content={[{ text: "Inspect this", type: "text" }]}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(
      container.querySelector('[data-agent-model-reasoning-trigger="true"]')
    ).toBeNull();
  });

  it("maps provider selection to the canonical Agent target identity", () => {
    const onAgentTargetChange = vi.fn();
    render(
      <AgentGUIQuickComposer
        agentTargets={[
          ...agentTargets,
          {
            agentTargetId: "agent:claude",
            label: "Claude Code",
            provider: "claude-code"
          }
        ]}
        capabilitiesByAgentTargetId={{
          ...capabilitiesByAgentTargetId,
          "agent:claude": { imageInput: true, workspaceReferences: true }
        }}
        content={[{ text: "Inspect this", type: "text" }]}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={onAgentTargetChange}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Switch provider" }));
    fireEvent.click(screen.getByRole("option", { name: "Claude Code" }));

    expect(onAgentTargetChange).toHaveBeenCalledWith("agent:claude");
  });

  it("fails closed for unknown or image-incompatible target capabilities", () => {
    const imageContent = [
      {
        data: "iVBORw0KGgo=",
        mimeType: "image/png" as const,
        type: "image" as const
      }
    ];
    const { container, rerender } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={{}}
        content={imageContent}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    const send = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-gui-composer-send"]'
    );
    expect(send?.disabled).toBe(true);

    rerender(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={{
          "agent:codex": { imageInput: false, workspaceReferences: true }
        }}
        content={imageContent}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(send?.disabled).toBe(true);
  });

  it("uses a host-injected i18n runtime", () => {
    const i18n = createI18nRuntime({
      dictionaries: [agentGuiI18nResources.en]
    });
    const translate = vi.spyOn(i18n, "t");
    render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        content={[{ text: "", type: "text" }]}
        i18n={i18n}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(translate).toHaveBeenCalledWith(
      "agentHost.agentGui.initialPlaceholder",
      expect.any(Object)
    );
  });

  it("fills host-owned height only when requested", () => {
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        content={[{ text: "", type: "text" }]}
        fillAvailableHeight={true}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const composer = container.querySelector(
      'form[data-layout="embedded"][data-fill-available-height="true"]'
    );

    expect(composer).not.toBeNull();
    expect(
      composer?.querySelector(".agent-gui-node__rich-text-editor-surface")
    ).not.toBeNull();
    expect(
      composer?.querySelector(".agent-gui-node__rich-text-editor-content")
    ).not.toBeNull();
  });

  it("uses the in-flow embedded layout for image drafts", () => {
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        content={[
          { text: "Inspect this screenshot", type: "text" },
          {
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
            name: "screenshot.png",
            type: "image"
          }
        ]}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const composer = container.querySelector<HTMLFormElement>(
      'form[data-layout="embedded"]'
    );
    const promptInputArea = composer?.querySelector(
      ".agent-gui-node__composer-prompt-input-area"
    );

    expect(composer).not.toBeNull();
    expect(
      promptInputArea?.querySelector(
        '[data-testid="agent-gui-composer-image-draft"]'
      )
    ).not.toBeNull();
  });

  it("enables workspace references when the embedding host supplies the picker", () => {
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        content={[{ text: "", type: "text" }]}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onRequestWorkspaceReferences={vi.fn().mockResolvedValue({
          files: [],
          mentionItems: []
        })}
        onSubmit={vi.fn()}
      />
    );

    const addIcon = container.querySelector(
      '[data-agent-reference-add-icon="true"]'
    );
    expect(addIcon?.closest("button")?.hasAttribute("disabled")).toBe(false);
  });

  it("shows the canonical project selector only with a real project capability", async () => {
    const project = {
      id: "project-alpha",
      label: "Alpha",
      path: "/workspace/alpha",
      pinnedAtUnixMs: 0
    };
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        content={[{ text: "", type: "text" }]}
        locale="zh-CN"
        selectedAgentTargetId="agent:codex"
        selectedProjectPath={null}
        userProjectApi={{
          list: vi.fn().mockResolvedValue({ projects: [project] }),
          prepareSelection: vi.fn().mockResolvedValue({
            isSelectedPathMissing: false,
            projects: [project],
            selection: { kind: "none" }
          }),
          selectDirectory: vi.fn().mockResolvedValue({ path: project.path }),
          use: vi.fn().mockResolvedValue(project)
        }}
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onProjectPathChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const noProjectIcon = container.querySelector(
      '[data-agent-project-trigger-no-workspace-icon="true"]'
    );

    await waitFor(() =>
      expect(noProjectIcon?.closest("button")?.hasAttribute("disabled")).toBe(
        false
      )
    );
    expect(noProjectIcon?.closest("button")).toHaveTextContent("不使用项目");
    expect(
      container
        .querySelector(".agent-gui-node__composer-footer")
        ?.contains(noProjectIcon)
    ).toBe(true);
  });

  it("does not fabricate a project catalog for a directory-only embedding", () => {
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        content={[{ text: "", type: "text" }]}
        selectedAgentTargetId="agent:codex"
        selectProjectDirectory={vi.fn().mockResolvedValue({
          path: "/workspace/alpha"
        })}
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onProjectPathChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(
      container.querySelector(
        '[data-agent-project-trigger-no-workspace-icon="true"]'
      )
    ).toBeNull();
  });

  it("renders a host action accessory beside send inside the AgentGUI token scope", () => {
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        composerActionAccessory={
          <span data-testid="quick-composer-action-accessory">Track Task</span>
        }
        content={[{ text: "Inspect this", type: "text" }]}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const scope = container.querySelector(".agent-gui-node__shell");
    const accessory = container.querySelector(
      '[data-testid="quick-composer-action-accessory"]'
    );
    const send = container.querySelector(
      '[data-testid="agent-gui-composer-send"]'
    );

    expect(scope).not.toBeNull();
    expect(scope?.contains(accessory)).toBe(true);
    expect(accessory?.parentElement).toBe(send?.parentElement);
  });

  it("can place the host action cluster in the Composer footer", () => {
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        composerActionAccessory={
          <span data-testid="quick-composer-footer-accessory">Track Task</span>
        }
        composerActionPlacement="footer"
        content={[{ text: "Inspect this", type: "text" }]}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const footer = container.querySelector(
      ".agent-gui-node__composer-footer-right"
    );
    const accessory = container.querySelector(
      '[data-testid="quick-composer-footer-accessory"]'
    );
    const send = container.querySelector(
      '[data-testid="agent-gui-composer-send"]'
    );

    expect(footer?.contains(accessory)).toBe(true);
    expect(footer?.contains(send)).toBe(true);
    expect(accessory?.parentElement).toBe(send?.parentElement);
  });

  it("hides the connector capability control quick-composer hosts cannot service", () => {
    const { container } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        content={[{ text: "Inspect this", type: "text" }]}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(
      container.querySelector(
        '[data-testid="agent-gui-composer-connectors-trigger"]'
      )
    ).toBeNull();
  });

  it("installs the mention service supplied by the embedding host", () => {
    const query = vi.fn().mockResolvedValue([]);
    const provider: RichTextTriggerProvider<{ id: string; label: string }> = {
      id: "file",
      trigger: "@",
      query,
      getItemKey: (item) => item.id,
      getItemLabel: (item) => item.label,
      toInsertResult: (item) => ({
        href: `/workspace/${item.id}`,
        kind: "markdown-link",
        label: item.label
      })
    };
    const mentionService = createRichTextMentionService({
      providers: [provider]
    });
    const listProviders = vi.spyOn(mentionService, "listProviders");
    const { unmount } = render(
      <AgentGUIQuickComposer
        agentTargets={agentTargets}
        capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
        content={[{ text: "", type: "text" }]}
        mentionService={mentionService}
        selectedAgentTargetId="agent:codex"
        workspaceId="workspace:test"
        onAgentTargetChange={vi.fn()}
        onContentChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(listProviders).toHaveBeenCalled();

    unmount();
    mentionService.dispose();
  });
});
