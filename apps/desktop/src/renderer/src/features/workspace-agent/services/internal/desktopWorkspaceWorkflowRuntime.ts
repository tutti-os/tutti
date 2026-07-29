import type {
  TuttidClient,
  TuttidEventStreamClient,
  WorkspaceWorkflowSnapshot,
  WorkspaceWorkflowTaskAssignment
} from "@tutti-os/client-tuttid-ts";
import type {
  AgentActivityRuntime,
  TuttiModePlanReviewSnapshot,
  TuttiModePlanReviewRuntime,
  TuttiModePlanTaskAssignmentInput,
  TuttiPlanIssueQueryResult,
  TuttiPlanIssueSource
} from "@tutti-os/agent-gui";
import { createDesktopTuttiModePlanAssignmentOptionsCache } from "./desktopTuttiModePlanAssignmentOptionsCache.ts";

export interface DesktopTuttiModePlanReviewRuntimeInput {
  composerOptionsRuntime: Pick<AgentActivityRuntime, "getComposerOptions">;
  tuttidClient: Pick<
    TuttidClient,
    | "listPendingWorkspaceWorkflows"
    | "listWorkspaceWorkflows"
    | "decideWorkspaceWorkflowCheckpoint"
    | "listAgentTargets"
    | "listWorkspaceAgents"
    | "listModelPlans"
    | "getWorkspaceIssueDetail"
    | "getWorkspaceIssueTaskDetail"
    | "updateWorkspaceIssueTask"
    | "cancelTuttiModeExecution"
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
          permissionModeId: task.permissionModeId,
          reasoningEffort: task.reasoningEffort,
          executionDirectory: task.executionDirectory,
          // Same daemon omit-empty hazard as issue task dependencyTaskIds:
          // spreading an omitted array throws and would reject the review load.
          dependsOn: task.dependsOn ? [...task.dependsOn] : [],
          parallelizable: task.parallelizable,
          autoAccept: task.autoAccept
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

function toTaskAssignmentRequest(
  assignments: readonly TuttiModePlanTaskAssignmentInput[] | undefined
): WorkspaceWorkflowTaskAssignment[] | undefined {
  if (!assignments || assignments.length === 0) return undefined;
  return assignments.map((assignment) => ({
    taskId: assignment.taskId,
    // undefined stays omitted so the daemon keeps the plan document value;
    // empty strings are explicit clears and must survive serialization.
    ...(assignment.agentTargetId !== undefined &&
    assignment.agentTargetId !== null
      ? { agentTargetId: assignment.agentTargetId }
      : {}),
    ...(assignment.modelPlanId !== undefined && assignment.modelPlanId !== null
      ? { modelPlanId: assignment.modelPlanId }
      : {}),
    ...(assignment.model !== undefined && assignment.model !== null
      ? { model: assignment.model }
      : {}),
    ...(assignment.permissionModeId !== undefined &&
    assignment.permissionModeId !== null
      ? { permissionModeId: assignment.permissionModeId }
      : {}),
    ...(assignment.reasoningEffort !== undefined &&
    assignment.reasoningEffort !== null
      ? { reasoningEffort: assignment.reasoningEffort }
      : {}),
    ...(assignment.parallelizable !== undefined &&
    assignment.parallelizable !== null
      ? { parallelizable: assignment.parallelizable }
      : {}),
    ...(assignment.autoAccept !== undefined && assignment.autoAccept !== null
      ? { autoAccept: assignment.autoAccept }
      : {})
  }));
}

/**
 * Desktop transport adapter for Tutti-owned workspace workflows. Workflow
 * rules and state transitions remain authoritative in tuttid.
 */
export function createDesktopTuttiModePlanReviewRuntime(
  input: DesktopTuttiModePlanReviewRuntimeInput
): TuttiModePlanReviewRuntime {
  let connectionStarted = false;
  const assignmentOptionsCache =
    createDesktopTuttiModePlanAssignmentOptionsCache(
      input.tuttidClient,
      input.composerOptionsRuntime
    );

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
          reason: decision.reason,
          taskAssignments: toTaskAssignmentRequest(decision.taskAssignments)
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
      // The daemon's canonical turn fan-out reports every root-turn
      // settlement on the activity stream. Relay it as the plan read-repair
      // trigger: a plan proposed mid-turn announces itself through one
      // workflow event, and if that single event is dropped no later
      // workflow signal re-reads review state.
      const unsubscribeActivity = eventStreamClient.subscribe(
        "agent.activity.updated",
        (event) => {
          const payload = event.payload;
          if (payload.workspaceId.trim() !== workspaceId) return;
          if (payload.eventType !== "turn_update") return;
          if (payload.data.turn.phase !== "settled") return;
          listener({
            kind: "session_settled",
            workspaceId,
            sourceSessionId: payload.agentSessionId
          });
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
      const unsubscribeModelCatalog = eventStreamClient.subscribe(
        "agent.model.catalog.invalidated",
        (event) => {
          const agentTargetIds = assignmentOptionsCache.invalidateProviders(
            workspaceId,
            event.payload.providers
          );
          if (agentTargetIds.length > 0) {
            listener({
              kind: "assignment_options_invalidated",
              workspaceId,
              agentTargetIds
            });
          }
        }
      );
      const unsubscribeModelConfiguration = eventStreamClient.subscribe(
        "agent.model.configuration.changed",
        (event) => {
          if (event.payload.workspaceId.trim() !== workspaceId) return;
          const agentTargetIds = assignmentOptionsCache.invalidateAgentTargets(
            workspaceId,
            event.payload.agentTargetIds
          );
          if (agentTargetIds.length > 0) {
            listener({
              kind: "assignment_options_invalidated",
              workspaceId,
              agentTargetIds
            });
          }
        },
        { scope: { workspaceId } }
      );

      if (!connectionStarted) {
        connectionStarted = true;
        void eventStreamClient.connect().catch((error: unknown) => {
          input.onEventStreamError?.(error);
        });
      }

      return () => {
        unsubscribe();
        unsubscribeActivity();
        unsubscribeConnection();
        unsubscribeModelCatalog();
        unsubscribeModelConfiguration();
      };
    },

    assignmentOptions: assignmentOptionsCache.source,
    planIssues: createPlanIssueSource(input)
  };
}

type IssueMaterializationCandidate =
  | {
      outcome: "succeeded";
      issueId: string;
      snapshot: WorkspaceWorkflowSnapshot;
    }
  | {
      outcome: "failed";
      errorMessage: string | null;
      snapshot: WorkspaceWorkflowSnapshot;
    };

// The newest create_issue outcome across the session's workflows decides what
// the conversation shows: the materialized Issue, or the durable failure that
// would otherwise leave an accepted plan with no panel at all.
function latestIssueMaterialization(
  snapshots: readonly WorkspaceWorkflowSnapshot[]
): IssueMaterializationCandidate | null {
  const candidates = snapshots.flatMap((snapshot) =>
    snapshot.operations
      .filter((operation) => operation.kind === "create_issue")
      .flatMap(
        (
          operation
        ): {
          candidate: IssueMaterializationCandidate;
          timestamp: number;
        }[] => {
          const timestamp =
            operation.completedAtUnixMs ?? operation.updatedAtUnixMs ?? 0;
          if (operation.status === "succeeded" && operation.issueId?.trim()) {
            return [
              {
                candidate: {
                  outcome: "succeeded" as const,
                  issueId: operation.issueId.trim(),
                  snapshot
                },
                timestamp
              }
            ];
          }
          if (operation.status === "failed") {
            return [
              {
                candidate: {
                  outcome: "failed" as const,
                  errorMessage: operation.errorMessage?.trim() || null,
                  snapshot
                },
                timestamp
              }
            ];
          }
          return [];
        }
      )
  );
  candidates.sort(
    (left, right) =>
      right.timestamp - left.timestamp ||
      right.candidate.snapshot.workflow.updatedAtUnixMs -
        left.candidate.snapshot.workflow.updatedAtUnixMs
  );
  return candidates[0]?.candidate ?? null;
}

// Read-only source for the conversation's embedded plan-issue panel: resolve
// the materialized Issue through the authoritative workspace workflow
// operation and relay live issue updates. Mutations stay in the Issue Manager.
function createPlanIssueSource(
  input: DesktopTuttiModePlanReviewRuntimeInput
): TuttiPlanIssueSource {
  return {
    async getSessionPlanIssue({
      workspaceId,
      sourceSessionId
    }): Promise<TuttiPlanIssueQueryResult> {
      const workflows = await input.tuttidClient.listWorkspaceWorkflows(
        workspaceId,
        sourceSessionId
      );
      const match = latestIssueMaterialization(workflows);
      if (!match) return null;
      if (match.outcome === "failed") {
        return {
          kind: "materialization_failed",
          workflowId: match.snapshot.workflow.id,
          sourceTurnId: match.snapshot.workflow.sourceTurnId ?? null,
          errorMessage: match.errorMessage
        };
      }
      const detail = await input.tuttidClient.getWorkspaceIssueDetail(
        workspaceId,
        match.issueId
      );
      return {
        kind: "issue",
        issue: {
          workflowId: match.snapshot.workflow.id,
          sourceTurnId: match.snapshot.workflow.sourceTurnId ?? null,
          issueId: detail.issue.issueId,
          topicId: detail.issue.topicId,
          title: detail.issue.title,
          dispatchPaused: detail.issue.dispatchPaused,
          // Superseded tasks are logically removed from the active graph: a
          // reworked task keeps its old copy for history (supersededAtUnix set)
          // but must not appear in the live plan. The Issue Manager drops them
          // via resolveIssueManagerVisibleSubtasks; this embedded panel has to
          // match, otherwise a reworked task's stale copy lingers as residue.
          tasks: detail.tasks
            .filter((task) => (task.supersededAtUnix ?? 0) <= 0)
            .map((task) => ({
              taskId: task.taskId,
              title: task.title,
              content: task.content,
              status: task.status,
              sortIndex: task.sortIndex,
              parallelizable: task.parallelizable === true,
              autoAccept: task.autoAccept === true,
              // The daemon omits empty arrays, so dependencyTaskIds arrives
              // undefined for any task with no dependencies (e.g. the first task
              // of every plan) despite the generated type declaring it required.
              // Spreading undefined throws, which rejected getSessionPlanIssue
              // and left the embedded panel permanently empty. Coalesce before
              // spread.
              dependencyTaskIds: task.dependencyTaskIds
                ? [...task.dependencyTaskIds]
                : []
            }))
        }
      };
    },
    subscribeIssueUpdates(workspaceId, listener) {
      const eventStreamClient = input.eventStreamClient;
      if (!eventStreamClient) return () => undefined;
      return eventStreamClient.subscribe(
        "workspace.issue.updated",
        (event) => {
          listener({ issueId: event.payload.issueId });
        },
        { scope: { workspaceId } }
      );
    },
    async cancelExecution({ workspaceId, issueId }): Promise<void> {
      await input.tuttidClient.cancelTuttiModeExecution(workspaceId, issueId);
    },
    async resolveTaskSession({ workspaceId, issueId, taskId }) {
      const detail = await input.tuttidClient.getWorkspaceIssueTaskDetail(
        workspaceId,
        issueId,
        taskId
      );
      const agentSessionId = detail.latestRun?.agentSessionId?.trim() ?? "";
      return agentSessionId ? { agentSessionId } : null;
    }
  };
}
