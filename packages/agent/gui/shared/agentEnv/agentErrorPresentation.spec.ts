import { describe, expect, it } from "vitest";
import { resolveAgentErrorPresentation } from "./agentErrorPresentation";

describe("resolveAgentErrorPresentation", () => {
  it("routes env-fixable failures to the matching wizard step", () => {
    const expectations: Record<string, { focus: string; actionKey: string }> = {
      auth_required: {
        focus: "auth",
        actionKey: "agentHost.agentGui.visibleErrorActionRelogin"
      },
      cli_not_found: {
        focus: "install",
        actionKey: "agentHost.agentGui.visibleErrorActionInstall"
      },
      cli_version_unsupported: {
        focus: "upgrade",
        actionKey: "agentHost.agentGui.visibleErrorActionUpgrade"
      },
      network_error: {
        focus: "network",
        actionKey: "agentHost.agentGui.visibleErrorActionCheckNetwork"
      },
      runtime_unavailable: {
        focus: "detect",
        actionKey: "agentHost.agentGui.visibleErrorActionDetect"
      }
    };
    for (const [code, expected] of Object.entries(expectations)) {
      const presentation = resolveAgentErrorPresentation(code);
      expect(presentation, code).not.toBeNull();
      expect(presentation?.focus, code).toBe(expected.focus);
      expect(presentation?.actionKey, code).toBe(expected.actionKey);
      expect(presentation?.messageKey, code).toBeTruthy();
    }
  });

  it("shows accurate copy but NO wizard CTA for transient/server-side failures", () => {
    for (const code of [
      "request_timed_out",
      "provider_config_timeout",
      "provider_stream_disconnected",
      "provider_concurrency_limit",
      "quota_or_rate_limit"
    ]) {
      const presentation = resolveAgentErrorPresentation(code);
      expect(presentation, code).not.toBeNull();
      expect(presentation?.focus, code).toBeNull();
      expect(presentation?.actionKey, code).toBeNull();
      expect(presentation?.messageKey, code).toBeTruthy();
    }
  });

  it("offers a self-detect escape hatch for ambiguous hard failures", () => {
    for (const code of ["process_exited", "provider_error", "unknown"]) {
      const presentation = resolveAgentErrorPresentation(code);
      expect(presentation?.focus, code).toBe("detect");
      expect(presentation?.actionKey, code).toBe(
        "agentHost.agentGui.visibleErrorActionDetect"
      );
      // Generic codes keep the caller's phase-aware title.
      expect(presentation?.messageKey, code).toBeNull();
    }
  });

  it("returns null for unknown/empty codes so the caller renders a plain card", () => {
    expect(resolveAgentErrorPresentation("WHATEVER")).toBeNull();
    expect(resolveAgentErrorPresentation(null)).toBeNull();
    expect(resolveAgentErrorPresentation(undefined)).toBeNull();
    expect(resolveAgentErrorPresentation("")).toBeNull();
  });
});
