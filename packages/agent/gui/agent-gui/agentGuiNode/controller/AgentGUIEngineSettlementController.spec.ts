import {
  normalizeAgentActivitySession,
  selectEngineHasVisibleQueuedSubmit,
  selectPendingSubmitsForSession
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import {
  createTestAgentSessionEngine,
  createTestAgentSessionEngineWithEffects
} from "../../../shared/testing/createTestAgentSessionEngine";
import {
  agentComposerDraftPrompt,
  emptyAgentComposerDraft
} from "../model/agentComposerDraft";
import type {
  AgentComposerDraft,
  SubmittedDraftSnapshot
} from "../model/agentGuiNodeTypes";
import { AgentGUIEngineSettlementController } from "./AgentGUIEngineSettlementController";

describe("AgentGUIEngineSettlementController", () => {
  it("clears a matching home draft after activation confirmation", () => {
    const engine = createTestAgentSessionEngine();
    const sourceScopeKey = "project:/workspace/app";
    const submittedDraft: AgentComposerDraft = [
      { type: "text", text: "first" }
    ];
    const snapshots: Record<string, SubmittedDraftSnapshot> = {
      "submit-1": { content: submittedDraft, sourceScopeKey }
    };
    let drafts: Record<string, AgentComposerDraft> = {
      [sourceScopeKey]: submittedDraft
    };
    const controller = new AgentGUIEngineSettlementController({
      applyDraftUpdate: (update) => {
        drafts = update(drafts);
      },
      engine,
      snapshots
    });
    const detach = controller.attach();

    requestActivation(engine, "submit-1");
    engine.dispatch({
      type: "session/upserted",
      session: normalizeAgentActivitySession({
        activeTurnId: null,
        agentSessionId: "session-1",
        createdAtUnixMs: Date.now() + 60_000,
        cwd: "/workspace/app",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        title: "first",
        workspaceId: "test-workspace"
      })
    });

    expect(agentComposerDraftPrompt(drafts[sourceScopeKey]!)).toBe("");
    expect(snapshots).toEqual({});
    detach();
    engine.dispose();
  });

  it("restores a failed activation only while its home draft is empty", async () => {
    let rejectActivation: (error: Error) => void = vi.fn();
    const engine = createTestAgentSessionEngine("test-workspace", {
      execute(command) {
        if (command.type !== "session/activate") {
          return Promise.resolve({ ok: true });
        }
        return new Promise((_, reject) => {
          rejectActivation = reject;
        });
      }
    });
    const sourceScopeKey = "project:/workspace/app";
    const snapshots: Record<string, SubmittedDraftSnapshot> = {
      "submit-1": {
        content: [{ type: "text", text: "first" }],
        sourceScopeKey
      }
    };
    let drafts: Record<string, AgentComposerDraft> = {
      [sourceScopeKey]: emptyAgentComposerDraft()
    };
    const controller = new AgentGUIEngineSettlementController({
      applyDraftUpdate: (update) => {
        drafts = update(drafts);
      },
      engine,
      snapshots
    });
    const detach = controller.attach();

    requestActivation(engine, "submit-1");
    rejectActivation(new Error("activation failed"));
    await vi.waitFor(() => {
      expect(agentComposerDraftPrompt(drafts[sourceScopeKey]!)).toBe("first");
    });
    expect(snapshots).toEqual({});
    detach();
    engine.dispose();
  });

  it("restores the original image preview after a non-visible send fails", async () => {
    const failed = vi.fn();
    const engine = createTestAgentSessionEngine("test-workspace", {
      execute(command) {
        return command.type === "queue/sendPrompt"
          ? Promise.reject(
              Object.assign(new Error("send failed"), {
                code: "workspace_operation_failed",
                reason: "agent.process_cleanup_pending"
              })
            )
          : Promise.resolve({ ok: true });
      }
    });
    engine.dispatch({
      type: "session/upserted",
      session: normalizeAgentActivitySession({
        activeTurnId: null,
        agentSessionId: "session-1",
        createdAtUnixMs: Date.now(),
        cwd: "/workspace/app",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        title: "session",
        workspaceId: "test-workspace"
      })
    });
    const sourceScopeKey = "session:session-1";
    const submittedDraft: AgentComposerDraft = [
      { type: "text", text: "" },
      {
        type: "image",
        id: "draft-image-1",
        mimeType: "image/png",
        name: "screen.png",
        path: "/workspace/screen.png",
        previewUrl: "data:image/png;base64,aWFnZQ=="
      }
    ];
    const snapshots: Record<string, SubmittedDraftSnapshot> = {
      "submit-1": {
        content: submittedDraft,
        sourceScopeKey
      }
    };
    let drafts: Record<string, AgentComposerDraft> = {
      [sourceScopeKey]: emptyAgentComposerDraft()
    };
    const controller = new AgentGUIEngineSettlementController({
      applyDraftUpdate: (update) => {
        drafts = update(drafts);
      },
      engine,
      isCurrentConversation: (agentSessionId) => agentSessionId === "session-1",
      onSubmitFailed: failed,
      snapshots
    });
    const detach = controller.attach();

    engine.dispatch({
      type: "submit/requested",
      agentSessionId: "session-1",
      clientSubmitId: "submit-1",
      content: [
        {
          type: "image",
          mimeType: "image/png",
          name: "screen.png",
          path: "/workspace/screen.png"
        }
      ],
      expiresAtUnixMs: Date.now() + 60_000,
      requestedAtUnixMs: Date.now(),
      workspaceId: "test-workspace"
    });

    await vi.waitFor(() => {
      expect(drafts[sourceScopeKey]).toEqual(submittedDraft);
    });
    expect(snapshots).toEqual({});
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0]?.[0]).toMatchObject({
      agentSessionId: "session-1",
      errorCode: "workspace_operation_failed",
      errorMessage: "send failed",
      errorReason: "agent.process_cleanup_pending",
      status: "failed"
    });
    detach();
    engine.dispose();
  });

  it("does not duplicate a failed visible queued submit into the composer", async () => {
    const engine = createTestAgentSessionEngine("test-workspace", {
      execute(command) {
        return command.type === "queue/sendPrompt"
          ? Promise.reject(new Error("send failed"))
          : Promise.resolve({ ok: true });
      }
    });
    engine.dispatch({
      type: "session/upserted",
      session: normalizeAgentActivitySession({
        activeTurnId: "turn-1",
        agentSessionId: "session-1",
        createdAtUnixMs: Date.now(),
        cwd: "/workspace/app",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        title: "session",
        workspaceId: "test-workspace"
      })
    });
    engine.dispatch({
      live: true,
      type: "turn/upserted",
      turn: {
        agentSessionId: "session-1",
        origin: "user_prompt",
        phase: "running",
        startedAtUnixMs: Date.now(),
        turnId: "turn-1",
        updatedAtUnixMs: Date.now()
      }
    });
    const sourceScopeKey = "session:session-1";
    const submittedDraft: AgentComposerDraft = [
      { type: "text", text: "" },
      {
        type: "image",
        id: "draft-image-1",
        mimeType: "image/png",
        name: "screen.png",
        path: "/workspace/screen.png",
        previewUrl: "data:image/png;base64,aWFnZQ=="
      }
    ];
    const snapshots: Record<string, SubmittedDraftSnapshot> = {
      "submit-1": { content: submittedDraft, sourceScopeKey }
    };
    let drafts: Record<string, AgentComposerDraft> = {
      [sourceScopeKey]: emptyAgentComposerDraft()
    };
    const controller = new AgentGUIEngineSettlementController({
      applyDraftUpdate: (update) => {
        drafts = update(drafts);
      },
      engine,
      snapshots
    });
    const detach = controller.attach();

    engine.dispatch({
      type: "submit/requested",
      agentSessionId: "session-1",
      clientSubmitId: "submit-1",
      content: [
        {
          type: "image",
          mimeType: "image/png",
          name: "screen.png",
          path: "/workspace/screen.png"
        }
      ],
      expiresAtUnixMs: Date.now() + 60_000,
      requestedAtUnixMs: Date.now(),
      workspaceId: "test-workspace"
    });
    expect(
      selectEngineHasVisibleQueuedSubmit(
        engine.getSnapshot(),
        "session-1",
        "submit-1"
      )
    ).toBe(true);
    engine.dispatch({
      live: true,
      type: "turn/upserted",
      turn: {
        agentSessionId: "session-1",
        origin: "user_prompt",
        outcome: "completed",
        phase: "settled",
        startedAtUnixMs: Date.now() - 1,
        turnId: "turn-1",
        updatedAtUnixMs: Date.now()
      }
    });

    await vi.waitFor(() => {
      expect(
        selectPendingSubmitsForSession(engine.getSnapshot(), "session-1").find(
          (submit) => submit.clientSubmitId === "submit-1"
        )?.status
      ).toBe("failed");
    });
    expect(
      selectEngineHasVisibleQueuedSubmit(
        engine.getSnapshot(),
        "session-1",
        "submit-1"
      )
    ).toBe(true);
    expect(drafts[sourceScopeKey]).toEqual(emptyAgentComposerDraft());
    expect(snapshots["submit-1"]?.content).toEqual(submittedDraft);
    detach();
    engine.dispose();
  });

  it("settles a Goal draft when Host durably accepts an applying operation", async () => {
    const engine = createTestAgentSessionEngineWithEffects("test-workspace", {
      controlGoal: () =>
        Promise.resolve({
          goal: { objective: "ship it", status: "active" },
          operationId: "goal-operation-1",
          session: sessionWithGoal("old goal"),
          state: {
            desired: { objective: "ship it", status: "active" },
            lastEvidence: { source: "test" },
            observed: { objective: "old goal", status: "active" },
            pendingOperationId: "goal-operation-1",
            revision: 2,
            syncStatus: "applying",
            tombstoned: false,
            updatedAtUnixMs: 2
          }
        })
    });
    engine.dispatch({
      session: sessionWithGoal("old goal"),
      type: "session/upserted"
    });
    const sourceScopeKey = "session:session-1";
    const submittedDraft: AgentComposerDraft = [
      { type: "text", text: "/goal ship it" }
    ];
    let drafts: Record<string, AgentComposerDraft> = {
      [sourceScopeKey]: submittedDraft
    };
    const goalControlSettlements = {
      "session-1": {
        action: "set" as const,
        clientSubmitId: "goal-submit-1",
        submittedDraftSnapshot: {
          content: submittedDraft,
          sourceScopeKey,
          targetAgentSessionId: "session-1"
        }
      }
    };
    const controller = new AgentGUIEngineSettlementController({
      applyDraftUpdate: (update) => {
        drafts = update(drafts);
      },
      engine,
      goalControlSettlements,
      snapshots: {}
    });
    const detach = controller.attach();

    expect(
      engine.controlGoal({
        action: "set",
        agentSessionId: "session-1",
        clientSubmitId: "goal-submit-1",
        objective: "ship it"
      }).accepted
    ).toBe(true);

    await vi.waitFor(() => {
      expect(agentComposerDraftPrompt(drafts[sourceScopeKey]!)).toBe("");
    });
    expect(goalControlSettlements).toEqual({});
    detach();
    engine.dispose();
  });

  it("reports a definitive Goal rejection without clearing its draft", async () => {
    const rejection = Object.assign(new Error("invalid goal"), {
      code: "invalid_request"
    });
    const engine = createTestAgentSessionEngineWithEffects("test-workspace", {
      controlGoal: () => Promise.reject(rejection)
    });
    engine.dispatch({
      session: sessionWithGoal("old goal"),
      type: "session/upserted"
    });
    const failed = vi.fn();
    const goalControlSettlements = {
      "session-1": {
        action: "clear" as const,
        clientSubmitId: "goal-submit-1",
        submittedDraftSnapshot: null
      }
    };
    const controller = new AgentGUIEngineSettlementController({
      applyDraftUpdate: vi.fn(),
      engine,
      goalControlSettlements,
      isCurrentConversation: () => true,
      onGoalControlFailed: failed,
      snapshots: {}
    });
    const detach = controller.attach();

    engine.controlGoal({
      action: "clear",
      agentSessionId: "session-1",
      clientSubmitId: "goal-submit-1"
    });

    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(failed.mock.calls[0]?.[0]).toMatchObject({
      clientSubmitId: "goal-submit-1",
      errorCode: "invalid_request",
      status: "failed"
    });
    expect(goalControlSettlements).toEqual({});
    detach();
    engine.dispose();
  });
});

function sessionWithGoal(objective: string) {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId: "session-1",
    cwd: "/workspace/app",
    goal: { objective, status: "active" },
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title: "session",
    workspaceId: "test-workspace"
  });
}

function requestActivation(
  engine: ReturnType<typeof createTestAgentSessionEngine>,
  clientSubmitId: string
): void {
  engine.dispatch({
    type: "activation/requested",
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId,
    content: [{ type: "text", text: "first" }],
    cwd: "/workspace/app",
    expiresAtUnixMs: Date.now() + 45_000,
    mode: "new",
    requestedAtUnixMs: Date.now(),
    requestId: "request-1",
    workspaceId: "test-workspace"
  });
}
