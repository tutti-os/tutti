import { describe, expect, it } from "vitest";
import {
  agentGuiWorkbenchPrefillPromptActivationType,
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
        provider: "hermes"
      })
    ).toBe("agent-gui:hermes:session:session%3A1");
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

  it("parses the unified dock identity separately from legacy provider dock ids", () => {
    expect(agentGuiWorkbenchUnifiedDockEntryId()).toBe("agent-gui:unified");
    expect(
      agentGuiWorkbenchDockIdentityFromIdentifier("agent-gui:unified")
    ).toEqual({ kind: "unifiedAggregate" });
    expect(
      agentGuiWorkbenchDockIdentityFromIdentifier("agent-gui:claude-code")
    ).toEqual({ kind: "legacyProvider", provider: "claude-code" });
  });

  it("launches sessions into provider panels until current session state can reuse a node", () => {
    const descriptor = createAgentGuiWorkbenchLaunchDescriptor({
      dockEntryId: "agent-gui",
      payload: {
        agentSessionId: "session-2",
        provider: "codex"
      },
      typeId: "agent-gui"
    });

    expect(descriptor).toMatchObject({
      activation: {
        payload: {
          agentSessionId: "session-2"
        },
        type: "agent-gui:open-session"
      },
      dockEntryId: "agent-gui",
      openInNewWindow: false,
      provider: "codex",
      reuseDockEntryNode: false,
      reuseExistingSessionNode: true,
      targetAgentSessionId: "session-2"
    });
    expect(descriptor.instanceId).toContain("agent-gui:codex:panel:");
  });

  it("launches sessions with target metadata into target panels", () => {
    expect(
      createAgentGuiWorkbenchLaunchDescriptor({
        dockEntryId: "agent-gui",
        payload: {
          agentSessionId: "session-2",
          agentTargetId: "local:codex",
          provider: "codex"
        },
        typeId: "agent-gui"
      })
    ).toMatchObject({
      instanceId: "agent-gui:codex:target:local%3Acodex",
      openInNewWindow: false,
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
    expect(descriptor.reuseDockEntryNode).toBe(true);
  });

  it("reuses unified aggregate dock nodes for empty launches", () => {
    expect(
      createAgentGuiWorkbenchLaunchDescriptor({
        dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
        payload: {
          provider: "codex"
        },
        typeId: "agent-gui"
      })
    ).toMatchObject({
      dockEntryId: "agent-gui:unified",
      openInNewWindow: false,
      provider: "codex",
      reuseDockEntryNode: true,
      targetAgentSessionId: null
    });
  });

  it("does not reuse dock nodes for empty launches into new windows", () => {
    expect(
      createAgentGuiWorkbenchLaunchDescriptor({
        dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
        payload: {
          openInNewWindow: true,
          provider: "codex"
        },
        typeId: "agent-gui"
      })
    ).toMatchObject({
      dockEntryId: "agent-gui:unified",
      openInNewWindow: true,
      provider: "codex",
      reuseDockEntryNode: false,
      targetAgentSessionId: null
    });
  });

  it("treats dock popup new-window launches as new windows", () => {
    expect(
      createAgentGuiWorkbenchLaunchDescriptor({
        dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
        launchSource: "dock-popup-new-window",
        payload: {
          provider: "codex"
        },
        typeId: "agent-gui"
      })
    ).toMatchObject({
      dockEntryId: "agent-gui:unified",
      openInNewWindow: true,
      provider: "codex",
      reuseDockEntryNode: false,
      targetAgentSessionId: null
    });
  });

  it("creates draft prompt launch requests for provider dock entries", () => {
    expect(
      createAgentGuiWorkbenchDraftLaunchRequest({
        agentTargetId: "local:codex",
        draftPrompt: "Review this issue",
        provider: "codex",
        userProjectPath: "/Users/example/project"
      })
    ).toEqual({
      dockEntryId: "agent-gui",
      payload: {
        agentTargetId: "local:codex",
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
          agentTargetId: "local:codex",
          draftPrompt: "Review this issue",
          provider: "codex"
        })
      )
    ).toMatchObject({
      activation: {
        payload: {
          agentTargetId: "local:codex",
          draftPrompt: "Review this issue",
          provider: "codex"
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

  it("launches draft prompts into new windows when requested", () => {
    const descriptor = createAgentGuiWorkbenchLaunchDescriptor(
      createAgentGuiWorkbenchDraftLaunchRequest({
        agentTargetId: "local:codex",
        draftPrompt: "Review this issue",
        openInNewWindow: true,
        provider: "codex"
      })
    );

    expect(descriptor).toMatchObject({
      activation: {
        payload: {
          agentTargetId: "local:codex",
          draftPrompt: "Review this issue",
          provider: "codex"
        },
        type: agentGuiWorkbenchPrefillPromptActivationType
      },
      dockEntryId: "agent-gui",
      openInNewWindow: true,
      provider: "codex",
      reuseDockEntryNode: false,
      reuseExistingSessionNode: false,
      targetAgentSessionId: null
    });
    expect(descriptor.instanceId).toContain("agent-gui:codex:panel:");
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
