import { describe, expect, it } from "vitest";
import {
  agentGuiWorkbenchDockEntryId,
  agentGuiWorkbenchPrefillPromptActivationType,
  agentGuiWorkbenchDockIdentityFromIdentifier,
  agentGuiWorkbenchInstanceId,
  agentGuiWorkbenchProviderFromIdentifier,
  agentGuiWorkbenchProviderFromLaunchRequest,
  agentGuiWorkbenchUnifiedDockEntryId,
  createAgentGuiWorkbenchDraftLaunchRequest,
  createAgentGuiWorkbenchInstanceId,
  createAgentGuiWorkbenchLaunchDescriptor,
  createAgentGuiWorkbenchSessionLaunchRequest,
  resolveAgentGuiWorkbenchLaunchDockEntryId
} from "./launch.ts";

describe("agent gui workbench launch contract", () => {
  it("keeps provider identity in instance ids instead of dock ids", () => {
    expect(agentGuiWorkbenchUnifiedDockEntryId()).toBe("agent-gui:unified");
    expect(agentGuiWorkbenchInstanceId("codex")).toBe("agent-gui:codex");
    expect(agentGuiWorkbenchProviderFromIdentifier("agent-gui")).toBeNull();
    expect(agentGuiWorkbenchProviderFromIdentifier("agent-gui:codex")).toBe(
      "codex"
    );
    expect(agentGuiWorkbenchProviderFromIdentifier("agent-gui:openclaw")).toBe(
      "openclaw"
    );
    expect(agentGuiWorkbenchProviderFromIdentifier("agent-gui:unknown")).toBe(
      "unknown"
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

  it("round trips encoded and legacy provider ids containing colons", () => {
    const instanceId = createAgentGuiWorkbenchInstanceId({
      agentTargetId: "extension:gemini",
      provider: "acp:gemini"
    });

    expect(instanceId).toBe("agent-gui:acp%3Agemini:target:extension%3Agemini");
    expect(agentGuiWorkbenchProviderFromIdentifier(instanceId)).toBe(
      "acp:gemini"
    );
    expect(
      agentGuiWorkbenchProviderFromIdentifier(
        "agent-gui:acp:gemini:target:extension%3Agemini"
      )
    ).toBe("acp:gemini");
    expect(
      agentGuiWorkbenchProviderFromIdentifier("agent-gui:acp:gemini")
    ).toBe("acp:gemini");
  });

  it("keeps deprecated dock identity helpers canonical", () => {
    expect(agentGuiWorkbenchDockEntryId("codex")).toBe("agent-gui:unified");
    expect(agentGuiWorkbenchDockEntryId("acp:gemini")).toBe(
      "agent-gui:unified"
    );
    expect(
      resolveAgentGuiWorkbenchLaunchDockEntryId({
        provider: "acp:gemini",
        requestedDockEntryId: "agent-gui:acp:gemini"
      })
    ).toBe("agent-gui:unified");
    expect(
      resolveAgentGuiWorkbenchLaunchDockEntryId({
        provider: "codex",
        requestedDockEntryId: null
      })
    ).toBe("agent-gui:unified");
  });

  it("requires launch providers in payloads", () => {
    expect(
      agentGuiWorkbenchProviderFromLaunchRequest({
        dockEntryId: "agent-gui:codex",
        payload: { provider: "claude-code" },
        typeId: "agent-gui"
      })
    ).toBe("claude-code");
    expect(() =>
      agentGuiWorkbenchProviderFromLaunchRequest({
        dockEntryId: "agent-gui:hermes",
        payload: {},
        typeId: "agent-gui"
      })
    ).toThrow("agent_gui_workbench.launch_provider_required");
    expect(() =>
      agentGuiWorkbenchProviderFromLaunchRequest({
        payload: null,
        typeId: "agent-gui"
      })
    ).toThrow("agent_gui_workbench.launch_provider_required");
  });

  it("uses the unified dock identity in launch descriptors", () => {
    const descriptor = createAgentGuiWorkbenchLaunchDescriptor({
      dockEntryId: "agent-gui:claude-code",
      payload: { provider: "codex" },
      typeId: "agent-gui"
    });

    expect(descriptor.dockEntryId).toBe("agent-gui:unified");
    expect(descriptor.instanceId).toContain("agent-gui:codex:panel:");
    expect(descriptor.provider).toBe("codex");
  });

  it("parses only the canonical aggregate dock identity", () => {
    expect(agentGuiWorkbenchUnifiedDockEntryId()).toBe("agent-gui:unified");
    expect(
      agentGuiWorkbenchDockIdentityFromIdentifier("agent-gui:unified")
    ).toEqual({ kind: "unifiedAggregate" });
    expect(
      agentGuiWorkbenchProviderFromIdentifier("agent-gui:unified")
    ).toBeNull();
    expect(agentGuiWorkbenchProviderFromIdentifier("agent-gui")).toBeNull();
    expect(agentGuiWorkbenchDockIdentityFromIdentifier("agent-gui")).toBeNull();
    expect(
      agentGuiWorkbenchDockIdentityFromIdentifier("agent-gui:claude-code")
    ).toBeNull();
    expect(
      agentGuiWorkbenchProviderFromIdentifier("agent-gui:extension-provider")
    ).toBe("extension-provider");
  });

  it("launches sessions into provider panels until current session state can reuse a node", () => {
    const descriptor = createAgentGuiWorkbenchLaunchDescriptor({
      dockEntryId: "agent-gui:unified",
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
      dockEntryId: "agent-gui:unified",
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
      dockEntryId: "agent-gui:codex",
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

  it("creates draft prompt launch requests for the unified dock entry", () => {
    expect(
      createAgentGuiWorkbenchDraftLaunchRequest({
        agentTargetId: "local:codex",
        draftPrompt: "Review this issue",
        model: "gpt-5.4",
        modelPlanId: "plan-codex",
        provider: "codex",
        userProjectPath: "/Users/example/project"
      })
    ).toEqual({
      dockEntryId: "agent-gui:unified",
      payload: {
        agentTargetId: "local:codex",
        draftPrompt: "Review this issue",
        model: "gpt-5.4",
        modelPlanId: "plan-codex",
        provider: "codex",
        userProjectPath: "/Users/example/project"
      },
      reason: "host",
      typeId: "agent-gui"
    });
  });

  it("launches draft prompts without reusing an unrelated unified node", () => {
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
      dockEntryId: "agent-gui:unified",
      provider: "codex",
      reuseDockEntryNode: false,
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
      dockEntryId: "agent-gui:unified",
      openInNewWindow: true,
      provider: "codex",
      reuseDockEntryNode: false,
      reuseExistingSessionNode: false,
      targetAgentSessionId: null
    });
    expect(descriptor.instanceId).toContain("agent-gui:codex:panel:");
  });

  it("creates session launch requests for the unified dock entry", () => {
    expect(
      createAgentGuiWorkbenchSessionLaunchRequest({
        agentSessionId: "session-2",
        provider: "claude-code"
      })
    ).toMatchObject({
      dockEntryId: "agent-gui:unified",
      payload: {
        agentSessionId: "session-2",
        provider: "claude-code"
      }
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
