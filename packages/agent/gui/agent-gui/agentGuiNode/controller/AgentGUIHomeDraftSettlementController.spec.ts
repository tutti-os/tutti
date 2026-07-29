import {
  normalizeAgentActivitySession,
  selectEngineHasVisibleQueuedSubmit,
  selectPendingSubmitsForSession
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import {
  agentComposerDraftPrompt,
  emptyAgentComposerDraft
} from "../model/agentComposerDraft";
import type {
  AgentComposerDraft,
  SubmittedDraftSnapshot
} from "../model/agentGuiNodeTypes";
import { AgentGUIHomeDraftSettlementController } from "./AgentGUIHomeDraftSettlementController";

describe("AgentGUIHomeDraftSettlementController", () => {
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
    const controller = new AgentGUIHomeDraftSettlementController({
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
    const controller = new AgentGUIHomeDraftSettlementController({
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
    const controller = new AgentGUIHomeDraftSettlementController({
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

    await vi.waitFor(() => {
      expect(drafts[sourceScopeKey]).toEqual(submittedDraft);
    });
    expect(snapshots).toEqual({});
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
    const controller = new AgentGUIHomeDraftSettlementController({
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
});

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
