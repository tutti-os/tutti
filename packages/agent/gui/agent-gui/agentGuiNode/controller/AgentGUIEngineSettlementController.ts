import {
  selectEngineHasVisibleQueuedSubmit,
  selectPendingActivations,
  selectPendingSubmitsForSession,
  selectSessionGoalControlSettlement,
  type AgentSessionEngine,
  type AgentSessionEngineState,
  type PendingSubmitIntentRecord,
  type SessionGoalControlSettlement
} from "@tutti-os/agent-activity-core";
import type { AgentActivityGoalControlAction } from "@tutti-os/agent-activity-core";
import type {
  AgentComposerDraft,
  SubmittedDraftSnapshot
} from "../model/agentGuiNodeTypes";
import { clearSubmittedDraftIfUnchanged } from "./agentGuiController.draftMessageHelpers";
import { restoreFailedAgentGUIHomeDraft } from "./agentGuiController.homeDraftHelpers";

export interface AgentGUIGoalControlPendingSettlement {
  action: AgentActivityGoalControlAction;
  clientSubmitId: string;
  submittedDraftSnapshot: SubmittedDraftSnapshot | null;
}

interface AgentGUIEngineSettlementControllerInput {
  applyDraftUpdate(
    update: (
      current: Record<string, AgentComposerDraft>
    ) => Record<string, AgentComposerDraft>
  ): void;
  engine: AgentSessionEngine;
  goalControlSettlements?: Record<string, AgentGUIGoalControlPendingSettlement>;
  isCurrentConversation?(agentSessionId: string): boolean;
  onGoalControlCleared?(): void;
  onGoalControlFailed?(settlement: SessionGoalControlSettlement): void;
  onSubmitFailed?(submit: PendingSubmitIntentRecord): void;
  snapshots: Record<string, SubmittedDraftSnapshot>;
}

export class AgentGUIEngineSettlementController {
  private readonly applyDraftUpdate: AgentGUIEngineSettlementControllerInput["applyDraftUpdate"];
  private readonly engine: AgentSessionEngine;
  private readonly goalControlSettlements: Record<
    string,
    AgentGUIGoalControlPendingSettlement
  >;
  private readonly isCurrentConversation: NonNullable<
    AgentGUIEngineSettlementControllerInput["isCurrentConversation"]
  >;
  private readonly onGoalControlCleared: NonNullable<
    AgentGUIEngineSettlementControllerInput["onGoalControlCleared"]
  >;
  private readonly onGoalControlFailed: NonNullable<
    AgentGUIEngineSettlementControllerInput["onGoalControlFailed"]
  >;
  private readonly onSubmitFailed: NonNullable<
    AgentGUIEngineSettlementControllerInput["onSubmitFailed"]
  >;
  private readonly snapshots: Record<string, SubmittedDraftSnapshot>;
  private unsubscribe: (() => void) | null = null;

  constructor(input: AgentGUIEngineSettlementControllerInput) {
    this.applyDraftUpdate = input.applyDraftUpdate;
    this.engine = input.engine;
    this.goalControlSettlements = input.goalControlSettlements ?? {};
    this.isCurrentConversation = input.isCurrentConversation ?? (() => false);
    this.onGoalControlCleared = input.onGoalControlCleared ?? (() => undefined);
    this.onGoalControlFailed = input.onGoalControlFailed ?? (() => undefined);
    this.onSubmitFailed = input.onSubmitFailed ?? (() => undefined);
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
      if (
        submit.status === "failed" &&
        this.isCurrentConversation(submit.agentSessionId)
      ) {
        this.onSubmitFailed(submit);
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
    this.settleGoalControls(state);
  }

  private settleGoalControls(state: AgentSessionEngineState): void {
    for (const [agentSessionId, pending] of Object.entries(
      this.goalControlSettlements
    )) {
      const settlement = selectSessionGoalControlSettlement(
        state,
        agentSessionId
      );
      if (
        !settlement ||
        settlement.clientSubmitId !== pending.clientSubmitId ||
        (settlement.status !== "accepted" &&
          settlement.status !== "succeeded" &&
          settlement.status !== "failed")
      ) {
        continue;
      }
      delete this.goalControlSettlements[agentSessionId];
      if (settlement.status === "failed") {
        if (this.isCurrentConversation(agentSessionId)) {
          this.onGoalControlFailed(settlement);
        }
        continue;
      }
      const submittedDraftSnapshot = pending.submittedDraftSnapshot;
      if (submittedDraftSnapshot) {
        this.applyDraftUpdate((drafts) =>
          clearSubmittedDraftIfUnchanged({
            drafts,
            snapshot: submittedDraftSnapshot
          })
        );
      }
      if (
        pending.action === "clear" &&
        this.isCurrentConversation(agentSessionId)
      ) {
        this.onGoalControlCleared();
      }
    }
  }
}
