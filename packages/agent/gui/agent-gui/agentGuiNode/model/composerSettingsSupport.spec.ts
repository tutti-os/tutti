import { describe, expect, it } from "vitest";
import { composerSettingsSupportFromOptions } from "./composerSettingsSupport";
import type { AgentActivityComposerOptions } from "@tutti-os/agent-activity-core";

function optionsFixture(input: {
  model: boolean;
  permission: boolean;
  capabilities?: string[];
}): AgentActivityComposerOptions {
  return {
    provider: "test",
    models: [],
    reasoningEfforts: [],
    speeds: [],
    modelConfigurable: input.model,
    reasoningConfigurable: input.model,
    permissionConfig: {
      configurable: input.permission,
      defaultValue: null,
      modes: []
    },
    runtimeContext: input.capabilities
      ? { capabilities: input.capabilities }
      : {},
    skills: [],
    loadedAtUnixMs: 0
  };
}

describe("composerSettingsSupportFromOptions", () => {
  // Equivalence truth table: must match the deleted composerSupportForProvider
  // hardcoded table column by column (except plan, which intentionally moves
  // from a hardcoded false to capability negotiation). The backend flag values
  // per provider are pinned by Go's TestComposerConfigConfigurableTruthTable.
  const providerFlags: Record<
    string,
    { model: boolean; permission: boolean; capabilities: string[] }
  > = {
    "claude-code": {
      model: true,
      permission: true,
      capabilities: [
        "imageInput",
        "skills",
        "compact",
        "tokenUsage",
        "rateLimits",
        "planMode",
        "interrupt"
      ]
    },
    codex: {
      model: true,
      permission: true,
      capabilities: [
        "imageInput",
        "skills",
        "compact",
        "tokenUsage",
        "rateLimits",
        "planMode",
        "interrupt"
      ]
    },
    gemini: { model: true, permission: false, capabilities: ["interrupt"] },
    hermes: { model: false, permission: false, capabilities: ["interrupt"] },
    nexight: { model: false, permission: true, capabilities: ["interrupt"] },
    openclaw: { model: false, permission: false, capabilities: [] }
  };
  const legacyTable: Record<
    string,
    { model: boolean; reasoning: boolean; permission: boolean }
  > = {
    "claude-code": { model: true, reasoning: true, permission: true },
    codex: { model: true, reasoning: true, permission: true },
    gemini: { model: true, reasoning: true, permission: false },
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
        provider === "claude-code" || provider === "codex"
      );
    });
  }

  it("returns all-false when composer options are absent", () => {
    expect(composerSettingsSupportFromOptions(null, null)).toEqual({
      model: false,
      reasoning: false,
      speed: false,
      permission: false,
      plan: false,
      browser: false
    });
  });

  it("prefers session runtime capabilities for plan", () => {
    const support = composerSettingsSupportFromOptions(
      optionsFixture({ model: true, permission: true, capabilities: [] }),
      { capabilities: ["planMode"] }
    );
    expect(support.plan).toBe(true);
  });
});
