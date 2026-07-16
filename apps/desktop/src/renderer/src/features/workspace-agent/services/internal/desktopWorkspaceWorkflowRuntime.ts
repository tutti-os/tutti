import type {
  TuttidClient,
  TuttidEventStreamClient,
  WorkspaceWorkflowSnapshot
} from "@tutti-os/client-tuttid-ts";
import type {
  TuttiModePlanReviewSnapshot,
  TuttiModePlanReviewRuntime
} from "@tutti-os/agent-gui";

export interface DesktopTuttiModePlanReviewRuntimeInput {
  tuttidClient: Pick<
    TuttidClient,
    "listPendingWorkspaceWorkflows" | "decideWorkspaceWorkflowCheckpoint"
  >;
  eventStreamClient?: Pick<
    TuttidEventStreamClient,
    "connect" | "subscribe" | "subscribeConnectionState"
  > | null;
  onEventStreamError?: (error: unknown) => void;
}

function toReviewSnapshot(
  snapshot: WorkspaceWorkflowSnapshot
): TuttiModePlanReviewSnapshot {
  const workflow = snapshot.workflow;
  return {
    workflow: {
      id: workflow.id,
      workspaceId: workflow.workspaceId,
      type: workflow.type,
      owner: workflow.owner,
      triggerKind: workflow.triggerKind,
      sourceSessionId: workflow.sourceSessionId,
      sourceTurnId: workflow.sourceTurnId,
      sourceToolCallId: workflow.sourceToolCallId,
      status: workflow.status,
      currentRevisionId: workflow.currentRevisionId
    },
    revisions: snapshot.revisions.map((revision) => ({
      id: revision.id,
      workflowId: revision.workflowId,
      sequence: revision.sequence,
      schemaVersion: revision.schemaVersion,
      documentPath: revision.documentPath,
      sha256: revision.sha256,
      producedByTurnId: revision.producedByTurnId,
      createdAtUnixMs: revision.createdAtUnixMs,
      document: {
        schema: revision.document.schema,
        phase: revision.document.phase,
        title: revision.document.title,
        topicId: revision.document.topicId,
        markdownBody: revision.document.markdownBody,
        execution: { ...revision.document.execution },
        budget: { ...revision.document.budget },
        tasks: revision.document.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          content: task.content,
          priority: task.priority,
          agentTargetId: task.agentTargetId,
          modelPlanId: task.modelPlanId,
          model: task.model,
          executionDirectory: task.executionDirectory,
          dependsOn: [...task.dependsOn]
        }))
      }
    })),
    checkpoints: snapshot.checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      workflowId: checkpoint.workflowId,
      kind: checkpoint.kind,
      revisionId: checkpoint.revisionId,
      status: checkpoint.status,
      decidedBy: checkpoint.decidedBy,
      decisionReason: checkpoint.decisionReason,
      createdAtUnixMs: checkpoint.createdAtUnixMs,
      updatedAtUnixMs: checkpoint.updatedAtUnixMs,
      decidedAtUnixMs: checkpoint.decidedAtUnixMs
    }))
  };
}

/**
 * Desktop transport adapter for Tutti-owned workspace workflows. Workflow
 * rules and state transitions remain authoritative in tuttid.
 */
export function createDesktopTuttiModePlanReviewRuntime(
  input: DesktopTuttiModePlanReviewRuntimeInput
): TuttiModePlanReviewRuntime {
  let connectionStarted = false;

  return {
    async listPending({ workspaceId, sourceSessionId }) {
      const snapshots = await input.tuttidClient.listPendingWorkspaceWorkflows(
        workspaceId,
        sourceSessionId
      );
      return snapshots.map(toReviewSnapshot);
    },

    async decide(decision) {
      await input.tuttidClient.decideWorkspaceWorkflowCheckpoint(
        decision.workspaceId,
        decision.workflowId,
        decision.checkpointId,
        {
          decision: decision.decision,
          decidedBy: decision.decidedBy,
          reason: decision.reason
        }
      );
    },

    subscribe(workspaceId, listener) {
      const eventStreamClient = input.eventStreamClient;
      if (!eventStreamClient) return () => undefined;

      const unsubscribe = eventStreamClient.subscribe(
        "workspace.workflow.updated",
        (event) => {
          if (event.scope?.workspaceId !== workspaceId) return;
          listener({ kind: "workflow_updated", workspaceId, ...event.payload });
        },
        { scope: { workspaceId } }
      );
      const unsubscribeConnection = eventStreamClient.subscribeConnectionState(
        (state) => {
          if (state === "connected") {
            listener({ kind: "connection_restored", workspaceId });
          }
        }
      );

      if (!connectionStarted) {
        connectionStarted = true;
        void eventStreamClient.connect().catch((error: unknown) => {
          input.onEventStreamError?.(error);
        });
      }

      return () => {
        unsubscribe();
        unsubscribeConnection();
      };
    }
  };
}
