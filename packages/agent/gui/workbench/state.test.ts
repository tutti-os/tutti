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
      lastActiveAgentSessionId: "session-1",
      lastActiveConversationTitle: "A title"
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
          composerOverridesByProvider: {
            codex: { model: "gpt-5" }
          },
          lastActiveAgentSessionId: "session-1",
          lastActiveConversationTitle: "Second"
        })
      )
    ).toBe(false);
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

  it("keeps node state in memory for workbench external state", () => {
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
    unsubscribe();

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
      lastActiveAgentSessionId: "session-1",
      lastActiveConversationTitle: "A title"
    });
  });
});
