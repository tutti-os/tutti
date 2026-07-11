import { describe, expect, it } from "vitest";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import { projectAgentEnvProvider } from "./agentEnvProviderProjection.ts";

describe("projectAgentEnvProvider", () => {
  it("projects ready providers without remediation actions", () => {
    expect(
      projectAgentEnvProvider({
        isLoading: false,
        provider: "codex",
        status: createStatus({
          actions: [],
          adapterInstalled: true,
          availability: "ready",
          provider: "codex"
        })
      })
    ).toEqual({
      actionIds: [],
      configDetected: true,
      pending: false,
      primaryActionId: null,
      provider: "codex",
      status: "connected"
    });
  });

  it("projects install and login remediation from daemon actions", () => {
    expect(
      projectAgentEnvProvider({
        isLoading: false,
        provider: "hermes",
        status: createStatus({
          actions: [
            { id: "install", kind: "daemon_action" },
            { id: "refresh", kind: "refresh" }
          ],
          adapterInstalled: false,
          availability: "not_installed",
          provider: "hermes"
        })
      })
    ).toMatchObject({
      actionIds: ["install", "refresh"],
      primaryActionId: "install",
      status: "available"
    });

    expect(
      projectAgentEnvProvider({
        isLoading: false,
        provider: "claude-code",
        status: createStatus({
          actions: [
            { id: "login", kind: "terminal_command" },
            { id: "refresh", kind: "refresh" }
          ],
          adapterInstalled: true,
          availability: "auth_required",
          provider: "claude-code"
        })
      })
    ).toMatchObject({
      actionIds: ["login", "refresh"],
      primaryActionId: "login",
      status: "auth_required"
    });
  });

  it("disables unsupported providers even when stale actions are present", () => {
    expect(
      projectAgentEnvProvider({
        isLoading: false,
        provider: "openclaw",
        status: createStatus({
          actions: [{ id: "refresh", kind: "refresh" }],
          adapterInstalled: true,
          availability: "unsupported",
          provider: "openclaw"
        })
      })
    ).toMatchObject({
      actionIds: [],
      primaryActionId: null,
      status: "unsupported"
    });
  });

  it("marks the active primary action pending", () => {
    expect(
      projectAgentEnvProvider({
        isLoading: false,
        pendingActionIds: new Set(["install"]),
        provider: "codex",
        status: createStatus({
          actions: [{ id: "install", kind: "daemon_action" }],
          adapterInstalled: false,
          availability: "not_installed",
          provider: "codex"
        })
      }).pending
    ).toBe(true);
  });

  it("treats a missing provider as checking only during a load", () => {
    expect(
      projectAgentEnvProvider({
        isLoading: true,
        provider: "hermes",
        status: null
      }).status
    ).toBe("checking");
    expect(
      projectAgentEnvProvider({
        isLoading: false,
        provider: "hermes",
        status: null
      }).status
    ).toBe("unknown");
  });
});

function createStatus(input: {
  actions: AgentProviderStatus["actions"];
  adapterInstalled: boolean;
  availability: AgentProviderStatus["availability"]["status"];
  provider: WorkspaceAgentProvider;
}): AgentProviderStatus {
  return {
    actions: input.actions,
    adapter: {
      command: [],
      installed: input.adapterInstalled
    },
    auth: {
      status: input.availability === "auth_required" ? "required" : "unknown"
    },
    availability: {
      status: input.availability
    },
    cli: {
      installed: input.availability !== "not_installed"
    },
    provider: input.provider
  };
}
