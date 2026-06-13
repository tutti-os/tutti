import assert from "node:assert/strict";
import test from "node:test";
import {
  areDesktopAgentGUIWorkbenchStatesEqual,
  createDesktopAgentGUINodeStateSource,
  createDefaultDesktopAgentGUINodeState,
  desktopAgentGUIProviderFromInstanceId,
  normalizeDesktopAgentGUINodeState,
  normalizeDesktopAgentGUIWorkbenchState,
  projectDesktopAgentGUIWorkbenchState,
  type DesktopAgentGUINodeState
} from "./desktopAgentGUINodeState.ts";

test("desktop agent gui node state preserves supported providers and falls back to codex", () => {
  assert.equal(
    normalizeDesktopAgentGUINodeState({
      provider: "claude-code"
    } as unknown as Partial<DesktopAgentGUINodeState>).provider,
    "claude-code"
  );
  assert.equal(
    normalizeDesktopAgentGUINodeState({
      provider: "unsupported"
    } as unknown as Partial<DesktopAgentGUINodeState>).provider,
    "codex"
  );
});

test("desktop agent gui workbench state only preserves whitelisted data", () => {
  const workbenchState = normalizeDesktopAgentGUIWorkbenchState({
    composerOverrides: { permissionModeId: "full-access" },
    conversationRailCollapsed: true,
    lastActiveAgentSessionId: "session-1",
    lastActiveConversationTitle: "A title",
    provider: "gemini"
  });

  assert.deepEqual(workbenchState, {
    composerOverrides: { permissionModeId: "full-access" },
    composerOverridesByProvider: null,
    conversationRailCollapsed: true,
    conversationRailWidthPx: null,
    lastActiveAgentSessionId: "session-1",
    lastActiveConversationTitle: "A title"
  });
});

test("desktop agent gui workbench projection preserves rail state and permission defaults", () => {
  assert.deepEqual(
    projectDesktopAgentGUIWorkbenchState({
      ...createDefaultDesktopAgentGUINodeState("gemini"),
      composerOverrides: { permissionModeId: "read-only" },
      conversationCount: 3,
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360.4,
      lastActiveAgentSessionId: "session-1",
      lastActiveConversationTitle: "A title"
    }),
    {
      composerOverrides: { permissionModeId: "read-only" },
      composerOverridesByProvider: null,
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1",
      lastActiveConversationTitle: "A title"
    }
  );
});

test("desktop agent gui workbench state equality includes rail state", () => {
  assert.equal(
    areDesktopAgentGUIWorkbenchStatesEqual(
      normalizeDesktopAgentGUIWorkbenchState({
        composerOverrides: { permissionModeId: "auto" },
        conversationRailCollapsed: false,
        lastActiveAgentSessionId: "session-1"
      }),
      normalizeDesktopAgentGUIWorkbenchState({
        composerOverrides: { permissionModeId: "auto" },
        lastActiveAgentSessionId: "session-1",
        provider: "gemini"
      })
    ),
    true
  );
  assert.equal(
    areDesktopAgentGUIWorkbenchStatesEqual(
      normalizeDesktopAgentGUIWorkbenchState({
        conversationRailCollapsed: false,
        lastActiveAgentSessionId: "session-1"
      }),
      normalizeDesktopAgentGUIWorkbenchState({
        composerOverrides: { permissionModeId: "auto" },
        conversationRailCollapsed: true,
        lastActiveAgentSessionId: "session-1"
      })
    ),
    false
  );
  assert.equal(
    areDesktopAgentGUIWorkbenchStatesEqual(
      normalizeDesktopAgentGUIWorkbenchState({
        lastActiveAgentSessionId: "session-1",
        lastActiveConversationTitle: "First"
      }),
      normalizeDesktopAgentGUIWorkbenchState({
        lastActiveAgentSessionId: "session-1",
        lastActiveConversationTitle: "Second"
      })
    ),
    false
  );
});

test("desktop agent gui workbench state preserves composer overrides by provider", () => {
  const workbenchState = normalizeDesktopAgentGUIWorkbenchState({
    composerOverridesByProvider: {
      codex: {
        model: "gpt-5",
        permissionModeId: "auto",
        reasoningEffort: "high"
      },
      gemini: {
        model: "gemini-pro",
        permissionModeId: "full-access",
        reasoningEffort: "medium"
      },
      unsupported: {
        model: "ignored"
      }
    }
  });

  assert.deepEqual(workbenchState.composerOverridesByProvider, {
    codex: {
      model: "gpt-5",
      permissionModeId: "auto",
      reasoningEffort: "high"
    },
    gemini: {
      model: "gemini-pro",
      permissionModeId: "full-access",
      reasoningEffort: "medium"
    }
  });
});

test("desktop agent gui node state normalizes partial runtime data", () => {
  assert.deepEqual(
    normalizeDesktopAgentGUINodeState({
      composerOverrides: { model: "gpt-5" },
      lastActiveAgentSessionId: "session-1",
      provider: "gemini"
    }),
    {
      ...createDefaultDesktopAgentGUINodeState("gemini"),
      composerOverrides: { model: "gpt-5" },
      lastActiveAgentSessionId: "session-1"
    }
  );
});

test("desktop agent gui node state ignores removed legacy composer defaults", () => {
  assert.deepEqual(
    normalizeDesktopAgentGUINodeState({
      defaultModel: "gpt-5",
      defaultPlanMode: true,
      defaultReasoningEffort: "high",
      lastActiveAgentSessionId: "session-1",
      provider: "gemini"
    } as unknown as Partial<DesktopAgentGUINodeState>),
    {
      ...createDefaultDesktopAgentGUINodeState("gemini"),
      lastActiveAgentSessionId: "session-1"
    }
  );
});

test("desktop agent gui provider derives from workbench instance id", () => {
  assert.equal(desktopAgentGUIProviderFromInstanceId("agent-gui"), "codex");
  assert.equal(
    desktopAgentGUIProviderFromInstanceId("agent-gui:claude-code"),
    "claude-code"
  );
  assert.equal(
    desktopAgentGUIProviderFromInstanceId("agent-gui:gemini:panel:abc"),
    "gemini"
  );
  assert.equal(
    desktopAgentGUIProviderFromInstanceId("agent-gui:unsupported"),
    "codex"
  );
});

test("desktop agent gui node state source keeps workbench rail state in memory", (t) => {
  const source = createDesktopAgentGUINodeStateSource({
    workspaceId: "workspace-1"
  });
  let notified = 0;
  const unsubscribe =
    source.externalStateSource.subscribe?.(() => {
      notified += 1;
    }) ?? (() => undefined);
  t.after(unsubscribe);

  source.writeNodeState({
    instanceId: "agent-gui:gemini",
    state: {
      composerOverrides: { permissionModeId: "full-access" },
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1",
      lastActiveConversationTitle: "A title"
    },
    typeId: "agent-gui"
  });

  assert.equal(notified, 1);
  assert.deepEqual(
    source.externalStateSource.getNodeState({
      instanceId: "agent-gui:gemini",
      nodeId: "node-1",
      typeId: "agent-gui",
      workspaceId: "workspace-1"
    }),
    {
      composerOverrides: { permissionModeId: "full-access" },
      composerOverridesByProvider: null,
      conversationRailCollapsed: true,
      conversationRailWidthPx: 360,
      lastActiveAgentSessionId: "session-1",
      lastActiveConversationTitle: "A title"
    }
  );
  assert.equal(
    source.externalStateSource.getNodeState({
      instanceId: "agent-gui:gemini",
      nodeId: "node-1",
      typeId: "issue-manager",
      workspaceId: "workspace-1"
    }),
    null
  );
});
