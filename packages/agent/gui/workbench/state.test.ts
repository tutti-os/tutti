import { describe, expect, it } from "vitest";
import {
  agentGuiWorkbenchProviderFromInstanceId,
  agentGuiWorkbenchProviderFromInstanceIdOrNull,
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
        composerOverridesByAgentTargetId: {
          "target-a": { model: "target-model" }
        },
        composerOverridesByProvider: {
          hermes: { permissionModeId: "read-only" },
          unsupported: { model: "ignored" }
        } as never,
        lastActiveAgentSessionId: "session-1",
        provider: "hermes"
      })
    ).toEqual({
      ...createDefaultAgentGuiWorkbenchNodeState("hermes"),
      composerOverrides: { model: "gpt-5" },
      composerOverridesByAgentTargetId: {
        "target-a": { model: "target-model" }
      },
      composerOverridesByProvider: {
        hermes: { permissionModeId: "read-only" }
      },
      lastActiveAgentSessionId: "session-1"
    });
  });

  it("projects only persisted workbench state", () => {
    expect(
      projectAgentGuiWorkbenchState({
        ...createDefaultAgentGuiWorkbenchNodeState("hermes"),
        composerOverrides: { permissionModeId: "read-only" },
        composerOverridesByAgentTargetId: {
          "target-a": { model: "target-model" }
        },
        composerOverridesByProvider: {
          hermes: { model: "hermes-2.5-pro" }
        },
        conversationCount: 3,
        conversationRailCollapsed: true,
        conversationRailWidthPx: 360.4,
        agentTargetId: "shared-agent:agent-1",
        lastActiveAgentSessionId: "session-1",
        lastActiveConversationTitle: "A title",
        providerTargetId: "legacy-target",
        providerTargetRef: {
          kind: "shared-agent",
          provider: "hermes",
          sharedAgentId: "agent-1"
        }
      })
    ).toEqual({
      agentTargetId: "shared-agent:agent-1",
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1",
      lastActiveConversationTitle: "A title"
    });
  });

  it("migrates legacy provider target ids to agent target selection", () => {
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
      agentTargetId: "shared-agent:agent-1"
    });

    expect(
      normalizeAgentGuiWorkbenchNodeState({
        provider: "codex",
        providerTargetId: "shared-agent:agent-1",
        providerTargetRef
      })
    ).toMatchObject({
      agentTargetId: "shared-agent:agent-1",
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
          composerOverridesByAgentTargetId: {
            "target-a": { model: "target-model" }
          },
          composerOverridesByProvider: {
            codex: { model: "gpt-5" }
          },
          conversationRailCollapsed: false,
          lastActiveAgentSessionId: "session-1"
        }),
        normalizeAgentGuiWorkbenchState({
          lastActiveAgentSessionId: "session-1",
          provider: "hermes"
        })
      )
    ).toBe(true);
    expect(
      areAgentGuiWorkbenchStatesEqual(
        normalizeAgentGuiWorkbenchState({
          lastActiveAgentSessionId: "session-1",
          providerTargetId: "legacy-target"
        }),
        normalizeAgentGuiWorkbenchState({
          lastActiveAgentSessionId: "session-1",
          agentTargetId: "legacy-target"
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
      agentGuiWorkbenchProviderFromInstanceId("agent-gui:hermes:panel:abc")
    ).toBe("hermes");
    expect(
      agentGuiWorkbenchProviderFromInstanceId("agent-gui:unsupported")
    ).toBe("codex");
  });

  it("returns null instead of defaulting when the provider is unresolved", () => {
    expect(
      agentGuiWorkbenchProviderFromInstanceIdOrNull("agent-gui")
    ).toBeNull();
    expect(agentGuiWorkbenchProviderFromInstanceIdOrNull("")).toBeNull();
    expect(agentGuiWorkbenchProviderFromInstanceIdOrNull(undefined)).toBeNull();
    expect(
      agentGuiWorkbenchProviderFromInstanceIdOrNull("agent-gui:unsupported")
    ).toBeNull();
    expect(
      agentGuiWorkbenchProviderFromInstanceIdOrNull("agent-gui:tutti-agent")
    ).toBe("tutti-agent");
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
      instanceId: "agent-gui:hermes",
      state: {
        agentTargetId: "daemon-hermes",
        conversationRailCollapsed: true,
        conversationRailWidthPx: 360,
        lastActiveAgentSessionId: "session-1"
      },
      typeId: "agent-gui"
    });

    expect(notified).toBe(1);
    expect(
      source.externalStateSource.getNodeState({
        instanceId: "agent-gui:hermes",
        nodeId: "node-1",
        typeId: "agent-gui",
        workspaceId: "workspace-1"
      })
    ).toEqual({
      agentTargetId: "daemon-hermes",
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1"
    });

    source.writeNodeState({
      instanceId: "agent-gui:hermes",
      nodeId: "node-1",
      state: {
        agentTargetId: "daemon-hermes-2",
        conversationRailCollapsed: false,
        conversationRailWidthPx: 420,
        lastActiveAgentSessionId: "session-2"
      },
      typeId: "agent-gui"
    });
    unsubscribe();

    expect(notified).toBe(2);
    expect(
      source.externalStateSource.getNodeState({
        instanceId: "agent-gui:hermes",
        nodeId: "node-1",
        typeId: "agent-gui",
        workspaceId: "workspace-1"
      })
    ).toEqual({
      agentTargetId: "daemon-hermes-2",
      conversationRailCollapsed: false,
      conversationRailWidthPx: 420,
      lastActiveAgentSessionId: "session-2"
    });
    expect(
      source.externalStateSource.getSnapshotNodeState?.({
        instanceId: "agent-gui:hermes",
        nodeId: "node-1",
        typeId: "agent-gui",
        workspaceId: "workspace-1"
      })
    ).toMatchObject({
      agentTargetId: "daemon-hermes-2",
      lastActiveAgentSessionId: "session-2"
    });
    expect(
      source.readNodeState({
        instanceId: "agent-gui:hermes",
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
        lastActiveAgentSessionId: "session-1"
      },
      typeId: "agent-gui"
    });
    source.writeNodeState({
      instanceId: "agent-gui",
      nodeId: "node-2",
      state: {
        lastActiveAgentSessionId: "session-2"
      },
      typeId: "agent-gui"
    });
    source.writeNodeState({
      instanceId: "agent-gui",
      nodeId: "node-2",
      state: {
        lastActiveAgentSessionId: "session-2"
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
      lastActiveAgentSessionId: "session-1"
    });
    expect(
      source.externalStateSource.getNodeState({
        instanceId: "agent-gui",
        nodeId: "node-2",
        typeId: "agent-gui",
        workspaceId: "workspace-1"
      })
    ).toMatchObject({
      lastActiveAgentSessionId: "session-2"
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
