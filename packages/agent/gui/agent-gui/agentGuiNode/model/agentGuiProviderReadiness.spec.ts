import { describe, expect, it } from "vitest";
import type { AgentGUIProviderReadinessGate } from "../../../types";
import {
  isAgentGUIProviderReady,
  resolveAgentGUIProviderReadinessAction,
  resolveAgentGUIProviderReadinessContent,
  resolveAgentGUIProviderReadinessGateForView
} from "./agentGuiProviderReadiness";

const labels = {
  providerGateCheckingTitle: "checking-title",
  providerGateCheckingDescription: "checking-description",
  providerGateCheckingAgentsDescription: "checking-agents-description",
  providerGateInstallTitle: "install-title",
  providerGateInstallDescription: "install-description",
  providerGateInstallAction: "install-action",
  providerGateLoginTitle: "login-title",
  providerGateLoginDescription: "login-description",
  providerGateLoginAction: "login-action",
  providerGateComingSoonTitle: "coming-soon-title",
  providerGateComingSoonDescription: "coming-soon-description",
  providerGateComingSoonAction: "coming-soon-action",
  providerGateUnavailableTitle: "unavailable-title",
  providerGateUnavailableDescription: "unavailable-description",
  providerGateRetryAction: "retry-action"
};

describe("agent gui provider readiness", () => {
  it("keeps active conversations outside provider setup readiness", () => {
    const checkingGate = {
      status: "checking"
    } satisfies AgentGUIProviderReadinessGate;

    expect(
      resolveAgentGUIProviderReadinessGateForView({
        activeConversationId: "session-claude",
        providerReadinessGates: {
          "claude-code": checkingGate,
          codex: null
        },
        selectedProvider: "codex"
      })
    ).toBeNull();
  });

  it("uses the selected provider gate on the new conversation surface", () => {
    const loginGate = {
      status: "auth_required"
    } satisfies AgentGUIProviderReadinessGate;

    expect(
      resolveAgentGUIProviderReadinessGateForView({
        activeConversationId: null,
        providerReadinessGates: {
          "claude-code": loginGate,
          codex: null
        },
        selectedProvider: "claude-code"
      })
    ).toBe(loginGate);
  });

  it("does not project checking into a connect action", () => {
    expect(isAgentGUIProviderReady({ status: "checking" })).toBe(false);
    expect(isAgentGUIProviderReady(null)).toBe(true);
    expect(resolveAgentGUIProviderReadinessAction("checking")).toBeNull();
    expect(resolveAgentGUIProviderReadinessContent("checking", labels)).toEqual(
      {
        description: "checking-description",
        title: "checking-title"
      }
    );
  });

  it("only exposes setup actions for explicit daemon statuses", () => {
    expect(resolveAgentGUIProviderReadinessAction("not_installed")).toBe(
      "install"
    );
    expect(resolveAgentGUIProviderReadinessAction("auth_required")).toBe(
      "login"
    );
    expect(resolveAgentGUIProviderReadinessAction("unavailable")).toBe(
      "refresh"
    );
  });
});
