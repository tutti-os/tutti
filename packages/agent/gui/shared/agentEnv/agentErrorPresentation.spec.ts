import { describe, expect, it } from "vitest";
import {
  classifyFailedAgentMessage,
  classifyRecoverableAgentMessage,
  resolveAgentErrorPresentation
} from "./agentErrorPresentation";

describe("classifyFailedAgentMessage", () => {
  it("recovers auth from a plain Claude 401 message", () => {
    expect(
      classifyFailedAgentMessage(
        "Failed to authenticate. API Error: 401 Invalid authentication credentials"
      )
    ).toBe("auth_required");
  });

  it("recovers cli/version/network codes from text", () => {
    expect(classifyFailedAgentMessage("spawn codex ENOENT")).toBe(
      "cli_not_found"
    );
    expect(
      classifyFailedAgentMessage("codex-acp requires a newer version of codex")
    ).toBe("cli_version_unsupported");
    expect(
      classifyFailedAgentMessage("getaddrinfo ENOTFOUND api.anthropic.com")
    ).toBe("network_error");
  });

  it("returns null for transient / non-env failures so they stay plain", () => {
    expect(classifyFailedAgentMessage("rate limit exceeded")).toBeNull();
    expect(classifyFailedAgentMessage("request timed out")).toBeNull();
    expect(classifyFailedAgentMessage("here is your answer")).toBeNull();
    expect(classifyFailedAgentMessage(null)).toBeNull();
  });

  it("recovers Cursor plan-limit copy into the quota bucket", () => {
    expect(classifyFailedAgentMessage("Upgrade your plan to continue")).toBe(
      "quota_or_rate_limit"
    );
    expect(classifyFailedAgentMessage("Add a payment method to continue")).toBe(
      "quota_or_rate_limit"
    );
  });
});

describe("classifyRecoverableAgentMessage", () => {
  it("recovers the standalone Claude Code login notice even when SDK marks it completed", () => {
    expect(
      classifyRecoverableAgentMessage({
        body: "Not logged in · Please run /login",
        statusKind: "completed"
      })
    ).toBe("auth_required");
  });

  it("does not reinterpret other completed messages", () => {
    expect(
      classifyRecoverableAgentMessage({
        body: "Authentication is configured and the request completed.",
        statusKind: "completed"
      })
    ).toBeNull();
  });

  it("does not reinterpret a normal Claude answer that discusses the notice", () => {
    expect(
      classifyRecoverableAgentMessage({
        body: 'The message "Not logged in · Please run /login" means authentication is required.',
        statusKind: "completed"
      })
    ).toBeNull();
  });
});

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

  it("keeps insufficient-credit product semantics out of AgentGUI", () => {
    expect(resolveAgentErrorPresentation("insufficient_credits")).toEqual({
      messageKey: "agentHost.agentGui.visibleErrorInsufficientCreditsUnknown",
      focus: null,
      actionKey: null
    });
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
