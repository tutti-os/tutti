import { describe, expect, it } from "vitest";
import {
  agentGuiWorkbenchProviderFromInstanceId,
  areAgentGuiWorkbenchStatesEqual,
  createAgentGuiWorkbenchNodeStateSource,
  createDefaultAgentGuiWorkbenchNodeState,
  normalizeAgentGuiWorkbenchNodeState,
  normalizeAgentGuiWorkbenchState,
  projectAgentGuiWorkbenchState
} from "./state.ts";

describe("agent gui workbench state", () => {
  it("normalizes providers and partial runtime data", () => {
    expect(
      normalizeAgentGuiWorkbenchNodeState({ provider: "claude-code" }).provider
    ).toBe("claude-code");
    expect(
      normalizeAgentGuiWorkbenchNodeState({
        provider: "unsupported"
      } as never).provider
    ).toBe("codex");
    expect(
      normalizeAgentGuiWorkbenchNodeState({
        composerOverrides: { model: "gpt-5" },
        composerOverridesByProvider: {
          gemini: { permissionModeId: "read-only" },
          unsupported: { model: "ignored" }
        } as never,
        lastActiveAgentSessionId: "session-1",
        provider: "gemini"
      })
    ).toEqual({
      ...createDefaultAgentGuiWorkbenchNodeState("gemini"),
      composerOverrides: { model: "gpt-5" },
      composerOverridesByProvider: {
        gemini: { permissionModeId: "read-only" }
      },
      lastActiveAgentSessionId: "session-1"
    });
  });

  it("projects only persisted workbench state", () => {
    expect(
      projectAgentGuiWorkbenchState({
        ...createDefaultAgentGuiWorkbenchNodeState("gemini"),
        composerOverrides: { permissionModeId: "read-only" },
        composerOverridesByProvider: {
          gemini: { model: "gemini-2.5-pro" }
        },
        conversationCount: 3,
        conversationRailCollapsed: true,
        conversationRailWidthPx: 360.4,
        lastActiveAgentSessionId: "session-1",
        lastActiveConversationTitle: "A title"
      })
    ).toEqual({
      composerOverrides: { permissionModeId: "read-only" },
      composerOverridesByProvider: {
        gemini: { model: "gemini-2.5-pro" }
      },
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1"
    });
  });

  it("persists provider target references as opaque state", () => {
    const providerTargetRef = {
      kind: "shared-agent",
      provider: "codex" as const,
      sharedAgentId: "agent-1"
    };

    expect(
      projectAgentGuiWorkbenchState({
        ...createDefaultAgentGuiWorkbenchNodeState("codex"),
        providerTargetId: "shared-agent:agent-1",
        providerTargetRef
      })
    ).toMatchObject({
      providerTargetId: "shared-agent:agent-1",
      providerTargetRef
    });

    expect(
      normalizeAgentGuiWorkbenchNodeState({
        provider: "codex",
        providerTargetId: "shared-agent:agent-1",
        providerTargetRef
      })
    ).toMatchObject({
      provider: "codex",
      providerTargetId: "shared-agent:agent-1",
      providerTargetRef
    });

    expect(
      normalizeAgentGuiWorkbenchNodeState({
        provider: "codex",
        providerTargetId: "shared-agent:agent-1",
        providerTargetRef: {
          ...providerTargetRef,
          provider: "claude-code"
        }
      })
    ).toMatchObject({
      provider: "codex",
      providerTargetId: "shared-agent:agent-1",
      providerTargetRef: null
    });
  });

  it("compares persisted workbench state", () => {
    expect(
      areAgentGuiWorkbenchStatesEqual(
        normalizeAgentGuiWorkbenchState({
          composerOverrides: { permissionModeId: "auto" },
          composerOverridesByProvider: {
            codex: { model: "gpt-5" }
          },
          conversationRailCollapsed: false,
          lastActiveAgentSessionId: "session-1"
        }),
        normalizeAgentGuiWorkbenchState({
          composerOverrides: { permissionModeId: "auto" },
          composerOverridesByProvider: {
            codex: { model: "gpt-5" }
          },
          lastActiveAgentSessionId: "session-1",
          provider: "gemini"
        })
      )
    ).toBe(true);
    expect(
      areAgentGuiWorkbenchStatesEqual(
        normalizeAgentGuiWorkbenchState({
          lastActiveAgentSessionId: "session-1",
          lastActiveConversationTitle: "First"
        }),
        normalizeAgentGuiWorkbenchState({
          lastActiveAgentSessionId: "session-1",
          lastActiveConversationTitle: "Second"
        })
      )
    ).toBe(true);
  });

  it("derives providers from workbench instance ids", () => {
    expect(agentGuiWorkbenchProviderFromInstanceId("agent-gui")).toBe("codex");
    expect(
      agentGuiWorkbenchProviderFromInstanceId("agent-gui:claude-code")
    ).toBe("claude-code");
    expect(
      agentGuiWorkbenchProviderFromInstanceId("agent-gui:gemini:panel:abc")
    ).toBe("gemini");
    expect(
      agentGuiWorkbenchProviderFromInstanceId("agent-gui:unsupported")
    ).toBe("codex");
  });

  it("uses instance launch state only until node state is written", () => {
    const source = createAgentGuiWorkbenchNodeStateSource({
      workspaceId: "workspace-1"
    });
    let notified = 0;
    const unsubscribe =
      source.externalStateSource.subscribe?.(() => {
        notified += 1;
      }) ?? (() => undefined);

    source.writeNodeState({
      instanceId: "agent-gui:gemini",
      state: {
        composerOverrides: { permissionModeId: "full-access" },
        composerOverridesByProvider: {
          gemini: { model: "gemini-2.5-pro" }
        },
        conversationRailCollapsed: true,
        conversationRailWidthPx: 360,
        lastActiveAgentSessionId: "session-1",
        lastActiveConversationTitle: "A title"
      },
      typeId: "agent-gui"
    });

    expect(notified).toBe(1);
    expect(
      source.externalStateSource.getNodeState({
        instanceId: "agent-gui:gemini",
        nodeId: "node-1",
        typeId: "agent-gui",
        workspaceId: "workspace-1"
      })
    ).toEqual({
      composerOverrides: { permissionModeId: "full-access" },
      composerOverridesByProvider: {
        gemini: { model: "gemini-2.5-pro" }
      },
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1"
    });

    source.writeNodeState({
      instanceId: "agent-gui:gemini",
      nodeId: "node-1",
      state: {
        composerOverrides: { permissionModeId: "read-only" },
        conversationRailCollapsed: false,
        conversationRailWidthPx: 420,
        lastActiveAgentSessionId: "session-2",
        lastActiveConversationTitle: "Node title"
      },
      typeId: "agent-gui"
    });
    unsubscribe();

    expect(notified).toBe(2);
    expect(
      source.externalStateSource.getNodeState({
        instanceId: "agent-gui:gemini",
        nodeId: "node-1",
        typeId: "agent-gui",
        workspaceId: "workspace-1"
      })
    ).toEqual({
      composerOverrides: { permissionModeId: "read-only" },
      composerOverridesByProvider: null,
      conversationRailCollapsed: false,
      conversationRailWidthPx: 420,
      lastActiveAgentSessionId: "session-2",
      lastActiveConversationTitle: "Node title"
    });
    expect(
      source.externalStateSource.getSnapshotNodeState?.({
        instanceId: "agent-gui:gemini",
        nodeId: "node-1",
        typeId: "agent-gui",
        workspaceId: "workspace-1"
      })
    ).toMatchObject({
      lastActiveAgentSessionId: "session-2",
      lastActiveConversationTitle: "Node title"
    });
    expect(
      source.readNodeState({
        instanceId: "agent-gui:gemini",
        typeId: "agent-gui"
      })
    ).toBeNull();
  });

  it("isolates multi-instance node state by workbench node id", () => {
    const source = createAgentGuiWorkbenchNodeStateSource({
      workspaceId: "workspace-1"
    });
    let notified = 0;
    const unsubscribe =
      source.externalStateSource.subscribe?.(() => {
        notified += 1;
      }) ?? (() => undefined);

    source.writeNodeState({
      instanceId: "agent-gui",
      nodeId: "node-1",
      state: {
        lastActiveAgentSessionId: "session-1",
        lastActiveConversationTitle: "First title"
      },
      typeId: "agent-gui"
    });
    source.writeNodeState({
      instanceId: "agent-gui",
      nodeId: "node-2",
      state: {
        lastActiveAgentSessionId: "session-2",
        lastActiveConversationTitle: "Second title"
      },
      typeId: "agent-gui"
    });
    source.writeNodeState({
      instanceId: "agent-gui",
      nodeId: "node-2",
      state: {
        lastActiveAgentSessionId: "session-2",
        lastActiveConversationTitle: "Second title"
      },
      typeId: "agent-gui"
    });
    unsubscribe();

    expect(notified).toBe(2);
    expect(
      source.externalStateSource.getNodeState({
        instanceId: "agent-gui",
        nodeId: "node-1",
        typeId: "agent-gui",
        workspaceId: "workspace-1"
      })
    ).toMatchObject({
      lastActiveAgentSessionId: "session-1",
      lastActiveConversationTitle: "First title"
    });
    expect(
      source.externalStateSource.getNodeState({
        instanceId: "agent-gui",
        nodeId: "node-2",
        typeId: "agent-gui",
        workspaceId: "workspace-1"
      })
    ).toMatchObject({
      lastActiveAgentSessionId: "session-2",
      lastActiveConversationTitle: "Second title"
    });
  });

  it("locates a node launch instanceId by the session it is showing", () => {
    const source = createAgentGuiWorkbenchNodeStateSource({
      workspaceId: "workspace-1"
    });

    // A conversation started fresh: its launch instanceId is panel-scoped (not
    // session-keyed), and its live state is written under a node-scoped key.
    source.writeNodeState({
      instanceId: "agent-gui:codex:panel:abc123",
      nodeId: "node-1",
      state: { lastActiveAgentSessionId: "session-xyz" },
      typeId: "agent-gui"
    });

    expect(source.findInstanceIdByAgentSessionId("session-xyz")).toBe(
      "agent-gui:codex:panel:abc123"
    );
    expect(source.findInstanceIdByAgentSessionId("  session-xyz  ")).toBe(
      "agent-gui:codex:panel:abc123"
    );
    expect(source.findInstanceIdByAgentSessionId("other-session")).toBeNull();
    expect(source.findInstanceIdByAgentSessionId("")).toBeNull();
  });
});
