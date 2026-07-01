import { describe, expect, it } from "vitest";
import {
  classifyFailedAgentMessage,
  reclassifyVisibleErrorDetail,
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

  it("recovers request_timed_out from Cloudflare 524 / gateway timeout text", () => {
    expect(
      classifyFailedAgentMessage(
        'acp session/prompt failed: Internal error: API Error: 524 {"error":{"code":524}}'
      )
    ).toBe("request_timed_out");
    expect(
      classifyFailedAgentMessage("gateway timeout from upstream proxy")
    ).toBe("request_timed_out");
  });
});

describe("reclassifyVisibleErrorDetail", () => {
  it("reclassifies provider_error with 524 detail to request_timed_out", () => {
    expect(
      reclassifyVisibleErrorDetail(
        "provider_error",
        'acp session/prompt failed: Internal error: API Error: 524 {"error":{"code":524}}'
      )
    ).toBe("request_timed_out");
  });

  it("reclassifies unknown with 504 detail to request_timed_out", () => {
    expect(
      reclassifyVisibleErrorDetail("unknown", "API Error: 504 Gateway Timeout")
    ).toBe("request_timed_out");
  });

  it("reclassifies process_exited with connection timed out detail", () => {
    expect(
      reclassifyVisibleErrorDetail("process_exited", "connection timed out")
    ).toBe("request_timed_out");
  });

  it("returns null for non-ambiguous codes", () => {
    expect(
      reclassifyVisibleErrorDetail("request_timed_out", "API Error: 524")
    ).toBeNull();
  });

  it("returns null when detail has no timeout markers", () => {
    expect(
      reclassifyVisibleErrorDetail("provider_error", "some other error")
    ).toBeNull();
  });

  it("returns null for null/empty inputs", () => {
    expect(reclassifyVisibleErrorDetail(null, "524")).toBeNull();
    expect(reclassifyVisibleErrorDetail("provider_error", null)).toBeNull();
    expect(reclassifyVisibleErrorDetail("provider_error", "")).toBeNull();
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
