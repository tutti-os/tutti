import { describe, expect, it } from "vitest";
import {
  agentGuiWorkbenchDockEntryId,
  agentGuiWorkbenchPrefillPromptActivationType,
  agentGuiWorkbenchDockIdentityFromIdentifier,
  agentGuiWorkbenchProviderFromLaunchRequest,
  agentGuiWorkbenchUnifiedDockEntryId,
  createAgentGuiWorkbenchDraftLaunchRequest,
  createAgentGuiWorkbenchInstanceId,
  createAgentGuiWorkbenchLaunchDescriptor,
  createAgentGuiWorkbenchSessionLaunchRequest,
  resolveAgentGuiWorkbenchLaunchDockEntryId
} from "./launch.ts";

describe("agent gui workbench launch contract", () => {
  it("keeps runtime instance ids opaque", () => {
    expect(agentGuiWorkbenchUnifiedDockEntryId()).toBe("agent-gui:unified");
    const first = createAgentGuiWorkbenchInstanceId();
    const second = createAgentGuiWorkbenchInstanceId();
    expect(first).toMatch(/^agent-gui:instance:/);
    expect(second).toMatch(/^agent-gui:instance:/);
    expect(first).not.toBe(second);
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
    expect(descriptor.instanceId).toMatch(/^agent-gui:instance:/);
    expect(descriptor.provider).toBe("codex");
  });

  it("parses only the canonical aggregate dock identity", () => {
    expect(agentGuiWorkbenchUnifiedDockEntryId()).toBe("agent-gui:unified");
    expect(
      agentGuiWorkbenchDockIdentityFromIdentifier("agent-gui:unified")
    ).toEqual({ kind: "unifiedAggregate" });
    expect(agentGuiWorkbenchDockIdentityFromIdentifier("agent-gui")).toBeNull();
    expect(
      agentGuiWorkbenchDockIdentityFromIdentifier("agent-gui:claude-code")
    ).toBeNull();
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
      reusePolicy: {
        agentSessionId: "session-2",
        kind: "current-session"
      },
      targetAgentSessionId: "session-2"
    });
    expect(descriptor.instanceId).toMatch(/^agent-gui:instance:/);
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
      openInNewWindow: false,
      reusePolicy: {
        agentSessionId: "session-2",
        kind: "current-session"
      },
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
    expect(descriptor.instanceId).toMatch(/^agent-gui:instance:/);
    expect(descriptor.openInNewWindow).toBe(true);
    expect(descriptor.reusePolicy).toEqual({ kind: "none" });
    expect(descriptor.targetAgentSessionId).toBe("session-2");
  });

  it("keeps provider metadata separate from opaque aggregate instances", () => {
    const descriptor = createAgentGuiWorkbenchLaunchDescriptor({
      dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
      payload: {
        provider: "claude-code"
      },
      typeId: "agent-gui"
    });

    expect(descriptor.dockEntryId).toBe("agent-gui:unified");
    expect(descriptor.instanceId).toMatch(/^agent-gui:instance:/);
    expect(descriptor.provider).toBe("claude-code");
    expect(descriptor.reusePolicy).toEqual({ kind: "dock-entry" });
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
      reusePolicy: { kind: "dock-entry" },
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
      reusePolicy: { kind: "none" },
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
      reusePolicy: { kind: "none" },
      targetAgentSessionId: null
    });
  });

  it("creates draft prompt launch requests for the unified dock entry", () => {
    expect(
      createAgentGuiWorkbenchDraftLaunchRequest({
        agentTargetId: "local:codex",
        draftPrompt: "Review this issue",
        provider: "codex",
        userProjectPath: "/Users/example/project"
      })
    ).toEqual({
      dockEntryId: "agent-gui:unified",
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
      reusePolicy: { kind: "none" },
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
      reusePolicy: { kind: "none" },
      targetAgentSessionId: null
    });
    expect(descriptor.instanceId).toMatch(/^agent-gui:instance:/);
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
      reusePolicy: { kind: "none" },
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
      reusePolicy: { kind: "none" },
      targetAgentSessionId: null
    });
  });
});
