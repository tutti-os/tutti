import {
  selectEngineHasVisibleQueuedSubmit,
  selectPendingActivations,
  selectPendingSubmitsForSession,
  type AgentSessionEngine,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import type {
  AgentComposerDraft,
  SubmittedDraftSnapshot
} from "../model/agentGuiNodeTypes";
import { clearSubmittedDraftIfUnchanged } from "./agentGuiController.draftMessageHelpers";
import { restoreFailedAgentGUIHomeDraft } from "./agentGuiController.homeDraftHelpers";

interface AgentGUIHomeDraftSettlementControllerInput {
  applyDraftUpdate(
    update: (
      current: Record<string, AgentComposerDraft>
    ) => Record<string, AgentComposerDraft>
  ): void;
  engine: AgentSessionEngine;
  snapshots: Record<string, SubmittedDraftSnapshot>;
}

export class AgentGUIHomeDraftSettlementController {
  private readonly applyDraftUpdate: AgentGUIHomeDraftSettlementControllerInput["applyDraftUpdate"];
  private readonly engine: AgentSessionEngine;
  private readonly snapshots: Record<string, SubmittedDraftSnapshot>;
  private unsubscribe: (() => void) | null = null;

  constructor(input: AgentGUIHomeDraftSettlementControllerInput) {
    this.applyDraftUpdate = input.applyDraftUpdate;
    this.engine = input.engine;
    this.snapshots = input.snapshots;
  }

  attach(): () => void {
    if (this.unsubscribe) return this.unsubscribe;
    this.settle(this.engine.getSnapshot());
    const unsubscribe = this.engine.subscribe((state) => this.settle(state));
    this.unsubscribe = () => {
      unsubscribe();
      this.unsubscribe = null;
    };
    return this.unsubscribe;
  }

  private settle(state: AgentSessionEngineState): void {
    const activationsByClientSubmitId = new Map(
      selectPendingActivations(state).flatMap((record) => {
        const clientSubmitId = record.clientSubmitId?.trim() ?? "";
        return record.mode === "new" && clientSubmitId
          ? [[clientSubmitId, record] as const]
          : [];
      })
    );
    for (const [clientSubmitId, snapshot] of Object.entries(this.snapshots)) {
      const activation = activationsByClientSubmitId.get(clientSubmitId);
      if (
        activation?.status === "confirmed" ||
        activation?.status === "failed" ||
        activation?.status === "canceled"
      ) {
        this.applyDraftUpdate((drafts) =>
          activation.status === "confirmed"
            ? clearSubmittedDraftIfUnchanged({ drafts, snapshot })
            : restoreFailedAgentGUIHomeDraft({
                draftKey: snapshot.sourceScopeKey,
                drafts,
                submittedDraft: snapshot.content
              })
        );
        delete this.snapshots[clientSubmitId];
        continue;
      }

      const targetAgentSessionId =
        snapshot.targetAgentSessionId ??
        (snapshot.sourceScopeKey.startsWith("session:")
          ? snapshot.sourceScopeKey.slice("session:".length)
          : "");
      if (!targetAgentSessionId) continue;
      const submit = selectPendingSubmitsForSession(
        state,
        targetAgentSessionId
      ).find((record) => record.clientSubmitId === clientSubmitId);
      if (
        submit?.status !== "accepted" &&
        submit?.status !== "confirmed" &&
        submit?.status !== "failed"
      ) {
        continue;
      }
      if (
        submit.status === "failed" &&
        selectEngineHasVisibleQueuedSubmit(
          state,
          submit.agentSessionId,
          clientSubmitId
        )
      ) {
        continue;
      }
      this.applyDraftUpdate((drafts) =>
        submit.status === "failed"
          ? restoreFailedAgentGUIHomeDraft({
              draftKey: snapshot.sourceScopeKey,
              drafts,
              submittedDraft: snapshot.content
            })
          : clearSubmittedDraftIfUnchanged({ drafts, snapshot })
      );
      delete this.snapshots[clientSubmitId];
    }
  }
}
