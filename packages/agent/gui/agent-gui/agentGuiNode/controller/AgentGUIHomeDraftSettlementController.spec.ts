import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
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
