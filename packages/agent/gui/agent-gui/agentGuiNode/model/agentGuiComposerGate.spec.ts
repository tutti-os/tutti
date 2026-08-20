import { describe, expect, it } from "vitest";
import {
  projectAgentGUIComposerGateControls,
  resolveAgentGUIComposerGate,
  type ResolveAgentGUIComposerGateInput
} from "./agentGuiComposerGate";

const readyInput: ResolveAgentGUIComposerGateInput = {
  activeConversationBusy: false,
  activeConversationId: "session-1",
  activeEngineHasPendingInteractions: false,
  activeLiveState: "active",
  activeConversationResumeUnavailable: false,
  agentTargetsLoading: false,
  authBlocked: false,
  hasNonRetryableRecoveryFailure: false,
  isCollaboratorConversation: false,
  isCreatingConversation: false,
  isInterrupting: false,
  isAwaitingTurnStart: false,
  isSubmitting: false,
  pendingApproval: false,
  pendingInteractivePrompt: false,
  providerReadinessGate: null,
  selectedAgentTargetUnavailable: false,
  settingsUpdatePending: false,
  sessionRuntimeBlockedReason: null,
  targetConnectionBlocked: false
};

describe("resolveAgentGUIComposerGate", () => {
  it("atomically unblocks a shared target when its connection becomes ready", () => {
    const connecting = resolveAgentGUIComposerGate({
      ...readyInput,
      targetConnectionBlocked: true
    });
    expect(connecting).toEqual({
      conversationBusy: false,
      isAwaitingTurnStart: false,
      runtime: {
        status: "blocked",
        reason: "target_connection",
        sessionRuntimeReason: null
      },
      editor: { status: "blocked", reason: "runtime_blocked" },
      submission: { status: "blocked", reason: "runtime_blocked" }
    });

    const ready = resolveAgentGUIComposerGate(readyInput);
    expect(ready).toEqual({
      conversationBusy: false,
      isAwaitingTurnStart: false,
      runtime: {
        status: "ready",
        reason: null,
        sessionRuntimeReason: null
      },
      editor: { status: "editable", reason: null },
      submission: { status: "ready", reason: null }
    });
    const controls = projectAgentGUIComposerGateControls({
      gate: ready,
      presentationEditorDisabled: false,
      presentationSubmitDisabled: false
    });
    expect(controls.editorDisabled).toBe(false);

    const editor = document.createElement("div");
    editor.contentEditable = String(!controls.editorDisabled);
    editor.tabIndex = 0;
    document.body.append(editor);
    editor.focus();
    expect(editor.contentEditable).toBe("true");
    expect(document.activeElement).toBe(editor);
    editor.remove();
  });

  it("blocks submission while a session settings update is pending", () => {
    expect(
      resolveAgentGUIComposerGate({
        ...readyInput,
        settingsUpdatePending: true
      })
    ).toMatchObject({
      runtime: { status: "ready", reason: null },
      editor: { status: "editable", reason: null },
      submission: { status: "blocked", reason: "settings_update_pending" }
    });
  });

  it("cannot expose ready submission with a stale runtime connection block", () => {
    for (const targetConnectionBlocked of [false, true]) {
      const gate = resolveAgentGUIComposerGate({
        ...readyInput,
        targetConnectionBlocked
      });
      if (gate.submission.status === "ready") {
        expect(gate.runtime.status).toBe("ready");
        expect(gate.editor.status).toBe("editable");
      }
    }
  });

  it("blocks editing and submission when the selected Home target is unavailable", () => {
    expect(
      resolveAgentGUIComposerGate({
        ...readyInput,
        activeConversationId: null,
        activeLiveState: "inactive",
        selectedAgentTargetUnavailable: true
      })
    ).toMatchObject({
      runtime: { status: "ready", reason: null },
      editor: { status: "blocked", reason: "provider_readiness" },
      submission: { status: "blocked", reason: "provider_readiness" }
    });
  });

  it("keeps the editor editable and projects queue submission while busy", () => {
    expect(
      resolveAgentGUIComposerGate({
        ...readyInput,
        activeConversationBusy: true
      })
    ).toMatchObject({
      conversationBusy: true,
      runtime: { status: "ready" },
      editor: { status: "editable", reason: null },
      submission: { status: "queue", reason: "conversation_busy" }
    });
  });

  it("blocks a prompt awaiting Turn start without exposing queue semantics", () => {
    expect(
      resolveAgentGUIComposerGate({
        ...readyInput,
        isAwaitingTurnStart: true,
        isSubmitting: true
      })
    ).toMatchObject({
      conversationBusy: false,
      isAwaitingTurnStart: true,
      runtime: { status: "ready" },
      editor: { status: "blocked", reason: "submitting" },
      submission: { status: "blocked", reason: "submitting" }
    });
  });

  it("blocks both editing and submission for a collaborator-owned session", () => {
    expect(
      resolveAgentGUIComposerGate({
        ...readyInput,
        isCollaboratorConversation: true
      })
    ).toMatchObject({
      runtime: { status: "ready" },
      editor: { status: "blocked", reason: "collaborator_read_only" },
      submission: { status: "blocked", reason: "collaborator_read_only" }
    });
  });

  it("keeps approval queue semantics while runtime commands are available", () => {
    expect(
      resolveAgentGUIComposerGate({
        ...readyInput,
        activeEngineHasPendingInteractions: true,
        pendingApproval: true
      })
    ).toMatchObject({
      runtime: { status: "ready" },
      editor: { status: "editable", reason: null },
      submission: { status: "queue", reason: "conversation_busy" }
    });
  });
});
