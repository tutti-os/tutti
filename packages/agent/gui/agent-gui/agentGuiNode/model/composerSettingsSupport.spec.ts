import { describe, expect, it } from "vitest";
import { composerSettingsSupportFromOptions } from "./composerSettingsSupport";
import {
  AGENT_CAPABILITY_KEYS,
  type AgentActivityComposerOptions,
  type AgentActivitySessionCapabilities
} from "@tutti-os/agent-activity-core";

function optionsFixture(input: {
  model: boolean;
  reasoning: boolean;
  permission: boolean;
  capabilities?: string[];
}): AgentActivityComposerOptions {
  return {
    provider: "test",
    capabilities: Object.fromEntries(
      AGENT_CAPABILITY_KEYS.map((key) => [
        key,
        (input.capabilities ?? []).includes(key)
      ])
    ) as unknown as AgentActivitySessionCapabilities,
    models: [],
    reasoningEfforts: [],
    speeds: [],
    modelConfigurable: input.model,
    reasoningConfigurable: input.reasoning,
    permissionConfig: {
      configurable: input.permission,
      defaultValue: null,
      modes: []
    },
    capabilityCatalog: [],
    skills: [],
    behavior: {
      collapseModelOptionsToLatest: false,
      modelOptionsAuthoritative: false,
      refreshModelOptionsAfterSettings: false,
      prewarmDraftSession: false,
      planModeExclusiveWithPermissionMode: false
    },
    loadedAtUnixMs: 0
  };
}

describe("composerSettingsSupportFromOptions", () => {
  it("keeps reasoning available when another model profile supports it", () => {
    const options = optionsFixture({
      model: true,
      reasoning: false,
      permission: false
    });
    options.reasoningOptionsByModel = {
      "opencode/big-pickle": { defaultValue: null, options: [] },
      "openai/gpt-5": {
        defaultValue: "medium",
        options: [{ value: "medium", label: "Medium" }]
      }
    };

    expect(composerSettingsSupportFromOptions(options, null).reasoning).toBe(
      true
    );
  });

  // Equivalence truth table: must match the deleted composerSupportForProvider
  // hardcoded table column by column (except plan, which intentionally moves
  // from a hardcoded false to capability negotiation). The backend flag values
  // per provider are pinned by Go's TestComposerConfigConfigurableTruthTable.
  const providerFlags: Record<
    string,
    {
      model: boolean;
      reasoning: boolean;
      permission: boolean;
      capabilities: string[];
    }
  > = {
    "claude-code": {
      model: true,
      reasoning: true,
      permission: true,
      capabilities: [
        "imageInput",
        "skills",
        "compact",
        "tokenUsage",
        "rateLimits",
        "planMode",
        "interrupt",
        "browserUse"
      ]
    },
    codex: {
      model: true,
      reasoning: true,
      permission: true,
      capabilities: [
        "imageInput",
        "skills",
        "compact",
        "tokenUsage",
        "rateLimits",
        "planMode",
        "interrupt",
        "browserUse"
      ]
    },
    opencode: {
      model: true,
      reasoning: false,
      permission: false,
      capabilities: ["interrupt", "planMode", "browserUse"]
    },
    cursor: {
      model: true,
      reasoning: false,
      permission: true,
      capabilities: ["interrupt", "planMode", "browserUse"]
    },
    hermes: {
      model: false,
      reasoning: false,
      permission: false,
      capabilities: ["interrupt"]
    },
    nexight: {
      model: false,
      reasoning: false,
      permission: true,
      capabilities: ["interrupt"]
    },
    openclaw: {
      model: false,
      reasoning: false,
      permission: false,
      capabilities: []
    }
  };
  const legacyTable: Record<
    string,
    { model: boolean; reasoning: boolean; permission: boolean }
  > = {
    "claude-code": { model: true, reasoning: true, permission: true },
    codex: { model: true, reasoning: true, permission: true },
    opencode: { model: true, reasoning: false, permission: false },
    cursor: { model: true, reasoning: false, permission: true },
    hermes: { model: false, reasoning: false, permission: false },
    nexight: { model: false, reasoning: false, permission: true },
    openclaw: { model: false, reasoning: false, permission: false }
  };

  for (const [provider, flags] of Object.entries(providerFlags)) {
    it(`matches the legacy table for ${provider}`, () => {
      const support = composerSettingsSupportFromOptions(
        optionsFixture(flags),
        null
      );
      expect(support.model).toBe(legacyTable[provider]!.model);
      expect(support.reasoning).toBe(legacyTable[provider]!.reasoning);
      expect(support.permission).toBe(legacyTable[provider]!.permission);
      expect(support.plan).toBe(
        provider === "claude-code" ||
          provider === "codex" ||
          provider === "cursor" ||
          provider === "opencode"
      );
      expect(support.browser).toBe(flags.capabilities.includes("browserUse"));
    });
  }

  it("returns all-false when composer options are absent", () => {
    expect(composerSettingsSupportFromOptions(null, null)).toEqual({
      model: false,
      reasoning: false,
      speed: false,
      permission: false,
      plan: false,
      browser: false,
      computer: false,
      planImplementation: false,
      permissionModeChangeDuringTurn: false,
      permissionModeChangeDeferred: false,
      modelSwitch: false
    });
  });

  it("prefers session runtime capabilities for plan", () => {
    const support = composerSettingsSupportFromOptions(
      optionsFixture({
        model: true,
        reasoning: true,
        permission: true,
        capabilities: []
      }),
      { planMode: true }
    );
    expect(support.plan).toBe(true);
  });
});
