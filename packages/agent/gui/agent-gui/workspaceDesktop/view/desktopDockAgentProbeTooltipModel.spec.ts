import { describe, expect, it } from "vitest";
import type { TranslateFn } from "../../../i18n/index";
import { buildDockAgentProbeTooltipLines } from "./desktopDockAgentProbeTooltipModel";

const translate = ((key: string) => key) as TranslateFn;

describe("buildDockAgentProbeTooltipLines", () => {
  it("renders an exact credits balance instead of reducing it to a percentage", () => {
    const creditsTranslate = ((
      key: string,
      options?: Record<string, unknown>
    ) => {
      if (key === "agentHost.workspaceAgentProbeQuotaCredits") return "Credits";
      if (key === "agentHost.workspaceAgentProbeQuotaCreditsRemaining") {
        return `${String(options?.amount)} Credits remaining`;
      }
      return key;
    }) as TranslateFn;
    const lines = buildDockAgentProbeTooltipLines(
      {
        provider: "acp:codebuddy",
        availability: { detailsVisible: false, status: "available" },
        usage: {
          billingMode: "provider_account",
          capturedAtUnixMs: 1,
          quotas: [
            {
              amountLimit: 2_100,
              amountRemaining: 2_100,
              amountUnit: "credits",
              percentRemaining: 100,
              quotaType: "credits"
            }
          ]
        }
      },
      false,
      creditsTranslate,
      { includeUsageLines: true }
    );

    expect(lines).toContainEqual({
      label: "Credits",
      primary: "2,100 Credits remaining"
    });
  });

  it("renders a stable subscription error instead of a generic empty-usage row", () => {
    const lines = buildDockAgentProbeTooltipLines(
      {
        provider: "acp:kimi-code",
        availability: {
          status: "unavailable",
          detailsVisible: false
        },
        lastError: {
          code: "subscription_required"
        }
      },
      false,
      translate,
      { includeUsageLines: true }
    );

    expect(lines).toContainEqual({
      label: "agentHost.workspaceAgentProbeDetailQuota",
      primary: "agentHost.workspaceAgentProbeErrorSubscriptionRequired"
    });
  });
});
