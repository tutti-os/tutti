import { describe, expect, it } from "vitest";

import type { TranslateFn } from "../../i18n/index";
import {
  resolveAgentGUIRailConfigProvider,
  slashStatusLimitsFromQuotas,
  slashStatusUsageErrorMessage
} from "./AgentGUINode.usage";

describe("resolveAgentGUIRailConfigProvider", () => {
  it("preserves an explicit unscoped provider for the all-agents view", () => {
    expect(resolveAgentGUIRailConfigProvider(null, "codex")).toBeNull();
  });

  it("falls back to the shell provider only when the prop is absent", () => {
    expect(resolveAgentGUIRailConfigProvider(undefined, "codex")).toBe("codex");
    expect(resolveAgentGUIRailConfigProvider("claude-code", "codex")).toBe(
      "claude-code"
    );
  });

  it("preserves parse failures as account-status parsing errors", () => {
    expect(slashStatusUsageErrorMessage("parse_failed", (key) => key)).toBe(
      "agentHost.agentGui.slashStatusUsageParseFailed"
    );
  });
});

describe("slashStatusLimitsFromQuotas", () => {
  it("keeps an exact credits balance while retaining progress percentage", () => {
    const translate = ((key: string, options?: Record<string, unknown>) => {
      if (key === "agentHost.workspaceAgentProbeQuotaCredits") return "Credits";
      if (key === "agentHost.workspaceAgentProbeQuotaCreditsRemaining") {
        return `${String(options?.amount)} Credits remaining`;
      }
      return key;
    }) as TranslateFn;

    expect(
      slashStatusLimitsFromQuotas(
        [
          {
            amountLimit: 2_100,
            amountRemaining: 2_100,
            amountUnit: "credits",
            percentRemaining: 100,
            quotaType: "credits"
          }
        ],
        null,
        translate
      )
    ).toEqual([
      {
        id: "credits::0",
        label: "Credits",
        percentRemaining: 100,
        reset: null,
        value: "2,100 Credits remaining"
      }
    ]);
  });
});
