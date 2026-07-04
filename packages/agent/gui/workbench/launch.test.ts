import { describe, expect, it } from "vitest";
import {
  agentGuiWorkbenchPrefillPromptActivationType,
  agentGuiWorkbenchDockEntryIdForLayout,
  agentGuiWorkbenchDockEntryId,
  agentGuiWorkbenchDockIdentityFromIdentifier,
  agentGuiWorkbenchInstanceId,
  agentGuiWorkbenchProviderFromIdentifier,
  agentGuiWorkbenchProviderFromLaunchRequest,
  agentGuiWorkbenchUnifiedDockEntryId,
  createAgentGuiWorkbenchDraftLaunchRequest,
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
    expect(agentGuiWorkbenchProviderFromIdentifier("agent-gui:codex")).toBe(
      "codex"
    );
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

  it("uses payload providers before legacy dock identifiers in launch descriptors", () => {
    const descriptor = createAgentGuiWorkbenchLaunchDescriptor({
      dockEntryId: "agent-gui:claude-code",
      payload: { provider: "codex" },
      typeId: "agent-gui"
    });

    expect(descriptor.dockEntryId).toBe("agent-gui");
    expect(descriptor.instanceId).toContain("agent-gui:codex:panel:");
    expect(descriptor.provider).toBe("codex");
  });

  it("parses the future unified dock identity separately from legacy provider dock ids", () => {
    expect(agentGuiWorkbenchUnifiedDockEntryId()).toBe("agent-gui:unified");
    expect(
      agentGuiWorkbenchDockEntryIdForLayout({
        dockLayout: "legacySplit",
        provider: "claude-code"
      })
    ).toBe("agent-gui:claude-code");
    expect(
      agentGuiWorkbenchDockEntryIdForLayout({
        dockLayout: "unified",
        provider: "claude-code"
      })
    ).toBe("agent-gui:unified");
    expect(
      agentGuiWorkbenchDockIdentityFromIdentifier("agent-gui:unified")
    ).toEqual({ kind: "unifiedAggregate" });
    expect(
      agentGuiWorkbenchDockIdentityFromIdentifier("agent-gui:claude-code")
    ).toEqual({ kind: "legacyProvider", provider: "claude-code" });
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
      openInNewWindow: false,
      provider: "codex",
      reuseDockEntryNode: false,
      reuseExistingSessionNode: true,
      targetAgentSessionId: "session-2"
    });
  });

  it("can launch an existing session into a new internal window", () => {
    const descriptor = createAgentGuiWorkbenchLaunchDescriptor({
      dockEntryId: "agent-gui",
      payload: {
        agentSessionId: "session-2",
        openInNewWindow: true,
        provider: "codex"
      },
      typeId: "agent-gui"
    });

    expect(descriptor.activation).toEqual({
      payload: {
        agentSessionId: "session-2"
      },
      type: "agent-gui:open-session"
    });
    expect(descriptor.instanceId).toContain("agent-gui:codex:panel:");
    expect(descriptor.openInNewWindow).toBe(true);
    expect(descriptor.reuseDockEntryNode).toBe(false);
    expect(descriptor.reuseExistingSessionNode).toBe(false);
    expect(descriptor.targetAgentSessionId).toBe("session-2");
  });

  it("keeps unified aggregate dock launches provider-specific at the instance layer", () => {
    const descriptor = createAgentGuiWorkbenchLaunchDescriptor({
      dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
      payload: {
        provider: "claude-code"
      },
      typeId: "agent-gui"
    });

    expect(descriptor.dockEntryId).toBe("agent-gui:unified");
    expect(descriptor.instanceId).toContain("agent-gui:claude-code:panel:");
    expect(descriptor.provider).toBe("claude-code");
  });

  it("creates draft prompt launch requests for provider dock entries", () => {
    expect(
      createAgentGuiWorkbenchDraftLaunchRequest({
        draftPrompt: "Review this issue",
        provider: "codex",
        userProjectPath: "/Users/example/project"
      })
    ).toEqual({
      dockEntryId: "agent-gui",
      payload: {
        draftPrompt: "Review this issue",
        provider: "codex",
        userProjectPath: "/Users/example/project"
      },
      reason: "host",
      typeId: "agent-gui"
    });
  });

  it("launches draft prompts into reusable provider nodes", () => {
    expect(
      createAgentGuiWorkbenchLaunchDescriptor(
        createAgentGuiWorkbenchDraftLaunchRequest({
          draftPrompt: "Review this issue",
          provider: "codex"
        })
      )
    ).toMatchObject({
      activation: {
        payload: {
          draftPrompt: "Review this issue"
        },
        type: agentGuiWorkbenchPrefillPromptActivationType
      },
      dockEntryId: "agent-gui",
      provider: "codex",
      reuseDockEntryNode: true,
      reuseExistingSessionNode: true,
      targetAgentSessionId: null
    });
  });

  it("does not reuse a shared unified aggregate dock node for provider-specific draft prompts", () => {
    expect(
      createAgentGuiWorkbenchLaunchDescriptor({
        dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
        payload: {
          draftPrompt: "Review this issue",
          provider: "codex"
        },
        typeId: "agent-gui"
      })
    ).toMatchObject({
      dockEntryId: "agent-gui:unified",
      provider: "codex",
      reuseDockEntryNode: false,
      targetAgentSessionId: null
    });

    expect(
      createAgentGuiWorkbenchLaunchDescriptor({
        dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
        payload: {
          draftPrompt: "Review this issue",
          provider: "claude-code"
        },
        typeId: "agent-gui"
      })
    ).toMatchObject({
      dockEntryId: "agent-gui:unified",
      provider: "claude-code",
      reuseDockEntryNode: false,
      targetAgentSessionId: null
    });
  });
});
