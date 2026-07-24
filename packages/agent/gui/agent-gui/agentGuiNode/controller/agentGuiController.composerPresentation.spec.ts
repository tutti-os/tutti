import { describe, expect, it } from "vitest";
import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";
import type { AgentGUINodeData } from "../../../types";
import {
  composerTargetDataForConversation,
  effectiveComposerSettingsFromOptions,
  enforceComposerModelBindingForHomeDefaults,
  isForegroundModelOptionsLoading,
  nodeDataMatchesComposerTarget,
  reconcileOptimisticComposerTarget,
  resolvePresentedComposerSettings,
  sanitizeComposerSettingsForOptions,
  verifyComposerModelAgainstNativeOptions
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

describe("composer model binding enforcement", () => {
  const options = (
    models: string[],
    overrides: Partial<AgentActivityComposerOptions> = {}
  ): AgentActivityComposerOptions => ({
    provider: "codex",
    capabilities: null,
    models: models.map((value) => ({ value, label: value })),
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
    ...overrides
  });

  it("classifies bare model ids against the native list", () => {
    expect(verifyComposerModelAgainstNativeOptions("m", null)).toBe(
      "unverifiable"
    );
    expect(verifyComposerModelAgainstNativeOptions("m", options([]))).toBe(
      "unverifiable"
    );
    expect(
      verifyComposerModelAgainstNativeOptions(
        "m",
        options(["m", "other"], { modelOptionsLoading: true })
      )
    ).toBe("unverifiable");
    expect(
      verifyComposerModelAgainstNativeOptions("m", options(["m", "other"]))
    ).toBe("verified");
    expect(
      verifyComposerModelAgainstNativeOptions("m", options(["other"]))
    ).toBe("rejected");
  });

  it("excludes requested-origin entries from catalog testimony", () => {
    // Warm-catalog append: the daemon adds the requested model to a settled
    // multi-entry list with a provenance marker. The marked entry must not
    // verify the model — only the raw catalog counts.
    const warm = options(["gpt-5.3-codex", "gpt-5.6-sol"], {
      effectiveSettings: { model: "x-ai/grok-4.5" }
    });
    warm.models.push({
      value: "x-ai/grok-4.5",
      label: "x-ai/grok-4.5",
      requested: true
    });
    expect(verifyComposerModelAgainstNativeOptions("x-ai/grok-4.5", warm)).toBe(
      "rejected"
    );
    expect(verifyComposerModelAgainstNativeOptions("gpt-5.6-sol", warm)).toBe(
      "verified"
    );
    // A list made solely of requested-origin entries has no catalog at all.
    const requestedOnly = options([]);
    requestedOnly.models.push({
      value: "x-ai/grok-4.5",
      label: "x-ai/grok-4.5",
      requested: true
    });
    expect(
      verifyComposerModelAgainstNativeOptions("x-ai/grok-4.5", requestedOnly)
    ).toBe("unverifiable");
  });

  it("treats a selected-model-only echo of the effective settings as unverifiable", () => {
    // The daemon's bootstrap composer options mirror the requested settings
    // as the sole model option (composerSelectedModelOptions); the list is
    // seeded from the very value under verification and proves nothing.
    const echo = options(["x-ai/grok-4.5"], {
      effectiveSettings: { model: "x-ai/grok-4.5" }
    });
    expect(verifyComposerModelAgainstNativeOptions("x-ai/grok-4.5", echo)).toBe(
      "unverifiable"
    );
    // A genuine single-entry catalog (no effective-settings mirror) still
    // counts as testimony.
    expect(
      verifyComposerModelAgainstNativeOptions(
        "x-ai/grok-4.5",
        options(["x-ai/grok-4.5"])
      )
    ).toBe("verified");
  });

  it("home defaults drop only positively rejected bare models", () => {
    const bare = { model: "x-ai/grok-4.5", modelPlanId: null };
    expect(
      enforceComposerModelBindingForHomeDefaults(
        bare,
        options(["gpt-5.3-codex"])
      )
    ).toMatchObject({ model: null, modelPlanId: null });
    // Unverifiable windows must not destroy a stored default.
    expect(enforceComposerModelBindingForHomeDefaults(bare, null)).toBe(bare);
    expect(enforceComposerModelBindingForHomeDefaults(bare, options([]))).toBe(
      bare
    );
    expect(
      enforceComposerModelBindingForHomeDefaults(
        { model: "x-ai/grok-4.5", modelPlanId: "mp-relay" },
        options(["gpt-5.3-codex"])
      )
    ).toMatchObject({ model: "x-ai/grok-4.5", modelPlanId: "mp-relay" });
  });
});
