import { describe, expect, it } from "vitest";
import type { AgentGUINodeData } from "../../../types";
import {
  composerTargetDataForConversation,
  effectiveComposerSettingsFromOptions,
  isForegroundModelOptionsLoading,
  nodeDataMatchesComposerTarget,
  reconcileOptimisticComposerTarget,
  resolvePresentedComposerSettings,
  sanitizeComposerSettingsForOptions
} from "./agentGuiController.composerPresentation";

describe("composer target presentation", () => {
  const selectedTarget = {
    agentTargetId: "local:codex",
    provider: "codex" as const,
    targetId: "local:codex",
    data: {
      provider: "codex" as const,
      agentTargetId: "local:codex",
      lastActiveAgentSessionId: null
    }
  };

  it("keeps the submitted target until the host node projection catches up", () => {
    const staleNodeData: AgentGUINodeData = {
      provider: "codex",
      lastActiveAgentSessionId: null
    };
    const optimisticTarget = {
      agentSessionId: "session-new",
      target: selectedTarget
    };

    expect(
      composerTargetDataForConversation({
        activeConversationId: "session-new",
        data: staleNodeData,
        optimisticTarget,
        selectedTarget
      })
    ).toBe(selectedTarget);
    expect(nodeDataMatchesComposerTarget(staleNodeData, selectedTarget)).toBe(
      false
    );
    const echoedNodeData = {
      ...staleNodeData,
      agentTargetId: "local:codex"
    };
    expect(nodeDataMatchesComposerTarget(echoedNodeData, selectedTarget)).toBe(
      true
    );
    expect(
      composerTargetDataForConversation({
        activeConversationId: "session-new",
        data: echoedNodeData,
        optimisticTarget,
        selectedTarget
      }).data
    ).toBe(echoedNodeData);
    expect(
      reconcileOptimisticComposerTarget({
        activeConversationId: "session-new",
        data: staleNodeData,
        optimisticTarget
      })
    ).toBe(optimisticTarget);
    expect(
      reconcileOptimisticComposerTarget({
        activeConversationId: "session-new",
        data: echoedNodeData,
        optimisticTarget
      })
    ).toBeNull();
    expect(
      reconcileOptimisticComposerTarget({
        activeConversationId: "session-other",
        data: staleNodeData,
        optimisticTarget
      })
    ).toBeNull();
  });

  it("treats live model discovery as foreground loading only without usable cached options", () => {
    expect(
      isForegroundModelOptionsLoading({
        modelOptionsLoading: true,
        selection: { currentValue: "gpt-5", options: [] },
        supportsModel: true
      })
    ).toBe(true);
    expect(
      isForegroundModelOptionsLoading({
        modelOptionsLoading: true,
        selection: {
          currentValue: "gpt-5",
          options: [{ value: "gpt-5", label: "GPT-5" }]
        },
        supportsModel: true
      })
    ).toBe(false);
  });

  it("fills missing optimistic values from effective pre-session settings", () => {
    const preloaded = effectiveComposerSettingsFromOptions({
      provider: "codex",
      capabilities: null,
      models: [],
      reasoningEfforts: [],
      speeds: [],
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
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
        permissionModeId: "full-access"
      }
    });

    expect(
      resolvePresentedComposerSettings({
        sessionSettings: null,
        optimisticSettings: { model: null, planMode: false },
        preloadedSettings: preloaded,
        homeSettings: { reasoningEffort: "medium", browserUse: true }
      })
    ).toMatchObject({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      planMode: false,
      browserUse: true,
      permissionModeId: "full-access"
    });
  });

  it("keeps every explicit optimistic default above a stale effective-settings snapshot", () => {
    expect(
      resolvePresentedComposerSettings({
        sessionSettings: null,
        optimisticSettings: {
          model: "new-model",
          permissionModeId: "full-access",
          reasoningEffort: "high",
          speed: "fast"
        },
        preloadedSettings: {
          model: "old-model",
          permissionModeId: "ask",
          reasoningEffort: "low",
          speed: "standard"
        },
        homeSettings: {}
      })
    ).toMatchObject({
      model: "new-model",
      permissionModeId: "full-access",
      reasoningEffort: "high",
      speed: "fast"
    });
  });

  it("does not turn an absent pre-session boolean into an explicit override", () => {
    const preloaded = effectiveComposerSettingsFromOptions({
      provider: "codex",
      capabilities: null,
      models: [],
      reasoningEfforts: [],
      speeds: [],
      skills: [],
      behavior: {
        collapseModelOptionsToLatest: false,
        modelOptionsAuthoritative: false,
        refreshModelOptionsAfterSettings: false,
        prewarmDraftSession: false,
        planModeExclusiveWithPermissionMode: false
      },
      loadedAtUnixMs: 1,
      effectiveSettings: { model: "gpt-5.3-codex" }
    });

    expect(preloaded?.planMode).toBeUndefined();
    expect(
      resolvePresentedComposerSettings({
        sessionSettings: null,
        optimisticSettings: null,
        preloadedSettings: preloaded,
        homeSettings: { planMode: true }
      }).planMode
    ).toBe(true);
  });

  it("applies descriptor-backed model catalog authority without provider checks", () => {
    const settings = { model: "stale-model", reasoningEffort: "high" };
    const options = {
      provider: "any-provider",
      capabilities: null,
      models: [{ value: "current-model", label: "Current" }],
      reasoningEfforts: [{ value: "high", label: "High" }],
      reasoningConfigurable: true,
      speeds: [],
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

    expect(sanitizeComposerSettingsForOptions(settings, options).model).toBe(
      "stale-model"
    );
    expect(
      sanitizeComposerSettingsForOptions(settings, {
        ...options,
        behavior: {
          collapseModelOptionsToLatest: false,
          modelOptionsAuthoritative: true,
          refreshModelOptionsAfterSettings: false,
          prewarmDraftSession: false,
          planModeExclusiveWithPermissionMode: false
        }
      }).model
    ).toBeNull();
  });

  it("clears a remembered effort when the selected model advertises no reasoning variants", () => {
    const settings = { model: "opencode/big-pickle", reasoningEffort: "high" };
    const options = {
      provider: "opencode",
      capabilities: null,
      models: [{ value: "opencode/big-pickle", label: "Big Pickle" }],
      reasoningEfforts: [],
      reasoningConfigurable: true,
      reasoningOptionsByModel: {
        "opencode/big-pickle": { defaultValue: null, options: [] }
      },
      speeds: [],
      skills: [],
      behavior: {
        collapseModelOptionsToLatest: false,
        modelOptionsAuthoritative: false,
        refreshModelOptionsAfterSettings: true,
        prewarmDraftSession: false,
        planModeExclusiveWithPermissionMode: false
      },
      loadedAtUnixMs: 1
    };

    expect(sanitizeComposerSettingsForOptions(settings, options)).toMatchObject(
      {
        model: "opencode/big-pickle",
        reasoningEffort: null
      }
    );
  });

  it("uses the selected model reasoning default when the provider-level config reflects another model", () => {
    const settings = {
      model: "openai/gpt-5.6-sol-pro",
      reasoningEffort: null
    };
    const options = {
      provider: "opencode",
      capabilities: null,
      models: [{ value: "openai/gpt-5.6-sol-pro", label: "GPT-5.6 Sol Pro" }],
      reasoningEfforts: [],
      reasoningConfigurable: false,
      reasoningOptionsByModel: {
        "openai/gpt-5.6-sol-pro": {
          defaultValue: "high",
          options: [
            { value: "off", label: "Off" },
            { value: "low", label: "Low" },
            { value: "high", label: "High" }
          ]
        }
      },
      speeds: [],
      skills: [],
      behavior: {
        collapseModelOptionsToLatest: false,
        modelOptionsAuthoritative: false,
        refreshModelOptionsAfterSettings: true,
        prewarmDraftSession: false,
        planModeExclusiveWithPermissionMode: false
      },
      loadedAtUnixMs: 1
    };

    expect(sanitizeComposerSettingsForOptions(settings, options)).toMatchObject(
      {
        model: "openai/gpt-5.6-sol-pro",
        reasoningEffort: "high"
      }
    );
  });

  it("clears reasoning effort when the target does not advertise it", () => {
    const settings = { model: "gpt-5.2", reasoningEffort: "high" };
    const cleared = sanitizeComposerSettingsForOptions(settings, {
      provider: "cursor",
      capabilities: null,
      models: [{ value: "gpt-5.2", label: "gpt-5.2" }],
      reasoningEfforts: [],
      reasoningConfigurable: false,
      speeds: [],
      skills: [],
      behavior: {
        collapseModelOptionsToLatest: true,
        modelOptionsAuthoritative: false,
        refreshModelOptionsAfterSettings: false,
        prewarmDraftSession: false,
        planModeExclusiveWithPermissionMode: false
      },
      loadedAtUnixMs: 1
    });

    expect(cleared.model).toBe("gpt-5.2");
    expect(cleared.reasoningEffort).toBeNull();
  });
});
