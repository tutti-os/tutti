import { describe, expect, it } from "vitest";
import {
  agentGuiWorkbenchDockEntryId,
  agentGuiWorkbenchInstanceId,
  agentGuiWorkbenchProviderFromIdentifier,
  agentGuiWorkbenchProviderFromLaunchRequest,
  createAgentGuiWorkbenchInstanceId,
  createAgentGuiWorkbenchLaunchDescriptor
} from "./launch.ts";

describe("agent gui workbench launch contract", () => {
  it("keeps codex as the legacy default dock entry", () => {
    expect(agentGuiWorkbenchDockEntryId("codex")).toBe("agent-gui");
    expect(agentGuiWorkbenchDockEntryId("claude-code")).toBe(
      "agent-gui:claude-code"
    );
    expect(agentGuiWorkbenchInstanceId("codex")).toBe("agent-gui:codex");
    expect(agentGuiWorkbenchProviderFromIdentifier("agent-gui")).toBe("codex");
    expect(agentGuiWorkbenchProviderFromIdentifier("agent-gui:openclaw")).toBe(
      "openclaw"
    );
    expect(agentGuiWorkbenchProviderFromIdentifier("agent-gui:unknown")).toBe(
      null
    );
  });

  it("creates stable session instance ids", () => {
    expect(
      createAgentGuiWorkbenchInstanceId({
        agentSessionId: "session:1",
        provider: "gemini"
      })
    ).toBe("agent-gui:gemini:session:session%3A1");
  });

  it("prefers payload providers before dock identifiers", () => {
    expect(
      agentGuiWorkbenchProviderFromLaunchRequest({
        dockEntryId: "agent-gui:codex",
        payload: { provider: "claude-code" },
        typeId: "agent-gui"
      })
    ).toBe("claude-code");
    expect(
      agentGuiWorkbenchProviderFromLaunchRequest({
        dockEntryId: "agent-gui:hermes",
        payload: {},
        typeId: "agent-gui"
      })
    ).toBe("hermes");
    expect(
      agentGuiWorkbenchProviderFromLaunchRequest({
        payload: null,
        typeId: "agent-gui"
      })
    ).toBe("codex");
  });

  it("launches existing sessions into exact session instances", () => {
    expect(
      createAgentGuiWorkbenchLaunchDescriptor({
        dockEntryId: "agent-gui",
        payload: {
          agentSessionId: "session-2",
          provider: "codex"
        },
        typeId: "agent-gui"
      })
    ).toEqual({
      activation: {
        payload: {
          agentSessionId: "session-2"
        },
        type: "agent-gui:open-session"
      },
      dockEntryId: "agent-gui",
      instanceId: "agent-gui:codex:session:session-2",
      provider: "codex",
      reuseDockEntryNode: true,
      targetAgentSessionId: "session-2"
    });
  });
});
