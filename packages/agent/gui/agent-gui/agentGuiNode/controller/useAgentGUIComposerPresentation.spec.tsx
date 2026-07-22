import { renderHook } from "@testing-library/react";
import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentSessionComposerSettings } from "../../../shared/agentSessionTypes";
import type { AgentGUINodeData } from "../../../types";
import { composerSettingsSupportFromOptions } from "../model/composerSettingsSupport";
import type { AgentGUIComposerTargetData } from "./agentGuiController.composerPresentation";
import { useAgentGUIComposerPresentation } from "./useAgentGUIComposerPresentation";

describe("useAgentGUIComposerPresentation", () => {
  it("keeps all explicit home defaults above stale options, then yields to authority after retirement", () => {
    const data: AgentGUINodeData = {
      provider: "opencode",
      agentTargetId: "local:opencode",
      lastActiveAgentSessionId: null
    };
    const target: AgentGUIComposerTargetData = {
      agentTargetId: "local:opencode",
      data,
      provider: "opencode",
      targetId: "local:opencode"
    };
    const options: AgentActivityComposerOptions = {
      provider: "opencode",
      capabilities: null,
      models: [{ value: "opencode/old-model", label: "Old model" }],
      reasoningEfforts: [{ value: "low", label: "Low" }],
      reasoningOptionsByModel: {
        "opencode/old-model": {
          defaultValue: "low",
          options: [{ value: "low", label: "Low" }]
        }
      },
      speeds: [{ value: "normal", label: "Normal" }],
      modelConfigurable: true,
      reasoningConfigurable: false,
      skills: [],
      behavior: {
        collapseModelOptionsToLatest: false,
        modelOptionsAuthoritative: false,
        refreshModelOptionsAfterSettings: false,
        prewarmDraftSession: false,
        planModeExclusiveWithPermissionMode: false
      },
      loadedAtUnixMs: 1,
      effectiveSettings: {
        model: "opencode/old-model",
        permissionModeId: "ask",
        reasoningEffort: "low",
        speed: "normal"
      },
      permissionConfig: {
        configurable: true,
        defaultValue: "ask",
        modes: [{ id: "ask", label: "Ask" }]
      }
    };
    const draftSettingsBySessionId = {
      "__agent_gui_node_defaults__:target:local:opencode": {
        model: "opencode/new-model",
        permissionModeId: "full-access",
        reasoningEffort: "high" as const,
        speed: "fast" as const
      }
    };
    const { result, rerender } = renderHook(
      ({ currentOptions, drafts }) =>
        useAgentGUIComposerPresentation({
          activeConversation: null,
          activeConversationId: null,
          activeEngineSession: null,
          activeSessionState: null,
          agentActivityRuntime: {
            projectPathIsRemote: false
          } as AgentActivityRuntime,
          composerSupport: {
            ...composerSettingsSupportFromOptions(currentOptions, null),
            reasoning: false
          },
          composerOptionsLoading: false,
          composerTargetProvider: "opencode",
          data,
          defaultReasoningEffort: null,
          draftSettingsBySessionId: drafts,
          draftSettingsBySessionIdRef: { current: drafts },
          onDataChangeRef: { current: vi.fn() },
          providerComposerOptions: currentOptions,
          selectedComposerTargetData: target,
          selectedProjectPath: null,
          shouldApplyPreparedProjectSelection: true,
          userProjects: [],
          setDraftSettingsBySessionId: vi.fn()
        }),
      {
        initialProps: {
          currentOptions: options,
          drafts: draftSettingsBySessionId as Record<
            string,
            AgentSessionComposerSettings
          >
        }
      }
    );

    expect(result.current.stableComposerSettings.draftSettings).toMatchObject({
      model: "opencode/new-model",
      permissionModeId: "full-access",
      reasoningEffort: "high",
      speed: "fast"
    });
    expect(result.current.stableComposerSettings).toMatchObject({
      selectedModelValue: "opencode/new-model",
      selectedPermissionModeValue: "full-access",
      selectedReasoningEffortValue: "high",
      selectedSpeedValue: "fast"
    });

    rerender({
      currentOptions: {
        ...options,
        loadedAtUnixMs: 2,
        models: [{ value: "opencode/authority-model", label: "Authority" }],
        reasoningEfforts: [{ value: "medium", label: "Medium" }],
        reasoningOptionsByModel: {
          "opencode/authority-model": {
            defaultValue: "medium",
            options: [{ value: "medium", label: "Medium" }]
          }
        },
        effectiveSettings: {
          model: "opencode/authority-model",
          permissionModeId: "sandbox",
          reasoningEffort: "medium",
          speed: "normal"
        },
        permissionConfig: {
          configurable: true,
          defaultValue: "sandbox",
          modes: [{ id: "sandbox", label: "Sandbox" }]
        }
      },
      drafts: {}
    });
    expect(result.current.stableComposerSettings).toMatchObject({
      selectedModelValue: "opencode/authority-model",
      selectedPermissionModeValue: "sandbox",
      selectedReasoningEffortValue: "medium",
      selectedSpeedValue: "normal"
    });
  });

  it("switches reasoning visibility and values with the selected model profile", () => {
    const data: AgentGUINodeData = {
      provider: "opencode",
      agentTargetId: "local:opencode",
      lastActiveAgentSessionId: "session-1"
    };
    const target: AgentGUIComposerTargetData = {
      agentTargetId: "local:opencode",
      data,
      provider: "opencode",
      targetId: "local:opencode"
    };
    const options: AgentActivityComposerOptions = {
      provider: "opencode",
      capabilities: null,
      models: [
        { value: "opencode/big-pickle", label: "Big Pickle" },
        { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" }
      ],
      reasoningEfforts: [{ value: "high", label: "High" }],
      reasoningOptionsByModel: {
        "opencode/big-pickle": {
          defaultValue: null,
          options: []
        },
        "gpt-5.6-sol": {
          defaultValue: "medium",
          options: [
            { value: "minimal", label: "Minimal" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra high" }
          ]
        },
        "gpt-5.6-luna": {
          defaultValue: "medium",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" }
          ]
        }
      },
      speeds: [],
      modelConfigurable: true,
      reasoningConfigurable: false,
      skills: [],
      behavior: {
        collapseModelOptionsToLatest: false,
        modelOptionsAuthoritative: false,
        refreshModelOptionsAfterSettings: false,
        prewarmDraftSession: false,
        planModeExclusiveWithPermissionMode: false
      },
      loadedAtUnixMs: 1
    };
    const { result, rerender } = renderHook(
      ({ model }: { model: string }) => {
        const draftSettingsBySessionId = {
          "session-1": {
            model,
            reasoningEffort: "high" as const
          }
        };
        return useAgentGUIComposerPresentation({
          activeConversation: null,
          activeConversationId: "session-1",
          activeEngineSession: null,
          activeSessionState: null,
          agentActivityRuntime: {
            projectPathIsRemote: false
          } as AgentActivityRuntime,
          composerSupport: composerSettingsSupportFromOptions(options, null),
          composerOptionsLoading: false,
          composerTargetProvider: "opencode",
          data,
          defaultReasoningEffort: "high",
          draftSettingsBySessionId,
          draftSettingsBySessionIdRef: { current: draftSettingsBySessionId },
          onDataChangeRef: { current: vi.fn() },
          providerComposerOptions: options,
          selectedComposerTargetData: target,
          selectedProjectPath: null,
          shouldApplyPreparedProjectSelection: false,
          userProjects: [],
          setDraftSettingsBySessionId: vi.fn()
        });
      },
      { initialProps: { model: "opencode/big-pickle" } }
    );

    expect(
      result.current.stableComposerSettings.availableReasoningEfforts
    ).toEqual([]);
    expect(
      result.current.stableComposerSettings.selectedReasoningEffortValue
    ).toBeNull();
    expect(
      result.current.stableComposerSettings.draftSettings.reasoningEffort
    ).toBeNull();

    rerender({ model: "gpt-5.6-sol" });

    expect(
      result.current.stableComposerSettings.availableReasoningEfforts.map(
        (option) => option.value
      )
    ).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(
      result.current.stableComposerSettings.selectedReasoningEffortValue
    ).toBe("high");

    rerender({ model: "gpt-5.6-luna" });

    expect(
      result.current.stableComposerSettings.availableReasoningEfforts.map(
        (option) => option.value
      )
    ).toEqual(["low", "medium"]);
    expect(
      result.current.stableComposerSettings.selectedReasoningEffortValue
    ).toBe("medium");

    rerender({ model: "opencode/big-pickle" });

    expect(
      result.current.stableComposerSettings.availableReasoningEfforts
    ).toEqual([]);
    expect(
      result.current.stableComposerSettings.selectedReasoningEffortValue
    ).toBeNull();
  });
});
