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
    providerTargetId: null,
    providerTargetRef: null,
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
    const runtimeContext = { appServerStartup: { models: "loading" } };

    expect(
      isForegroundModelOptionsLoading({
        runtimeContext,
        selection: { currentValue: "gpt-5", options: [] },
        supportsModel: true
      })
    ).toBe(true);
    expect(
      isForegroundModelOptionsLoading({
        runtimeContext,
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
      models: [],
      reasoningEfforts: [],
      speeds: [],
      skills: [],
      behavior: {
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

  it("does not turn an absent pre-session boolean into an explicit override", () => {
    const preloaded = effectiveComposerSettingsFromOptions({
      provider: "codex",
      models: [],
      reasoningEfforts: [],
      speeds: [],
      skills: [],
      behavior: {
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
      models: [{ value: "current-model", label: "Current" }],
      reasoningEfforts: [{ value: "high", label: "High" }],
      speeds: [],
      skills: [],
      behavior: {
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
          modelOptionsAuthoritative: true,
          refreshModelOptionsAfterSettings: false,
          prewarmDraftSession: false,
          planModeExclusiveWithPermissionMode: false
        }
      }).model
    ).toBeNull();
  });
});
