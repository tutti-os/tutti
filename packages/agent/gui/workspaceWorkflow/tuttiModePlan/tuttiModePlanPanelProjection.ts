export type TuttiModePlanWorkflowStatus =
  | "pending_review"
  | "in_progress"
  | "accepted"
  | "rejected"
  | "completed"
  | "failed"
  | "canceled";

export type TuttiModePlanCheckpointKind =
  | "configuration_review"
  | "task_review";

export type TuttiModePlanCheckpointStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "superseded"
  | "canceled";

// UI-facing review snapshot. It deliberately excludes workflow operations,
// turn links, actionable items, and unrelated timestamps from the daemon DTO.
// Desktop must explicitly map the transport contract into this narrow seam.
export interface TuttiModePlanReviewSnapshot {
  workflow: TuttiModePlanWorkflow;
  revisions: TuttiModePlanRevision[];
  checkpoints: TuttiModePlanCheckpoint[];
}

export interface TuttiModePlanWorkflow {
  id: string;
  workspaceId: string;
  type: string;
  owner: string;
  triggerKind: string;
  sourceSessionId: string;
  sourceTurnId?: string | null;
  sourceToolCallId?: string | null;
  status: TuttiModePlanWorkflowStatus;
  currentRevisionId: string;
}

export interface TuttiModePlanRevision {
  id: string;
  workflowId: string;
  sequence: number;
  schemaVersion: string;
  documentPath: string;
  sha256: string;
  producedByTurnId?: string | null;
  createdAtUnixMs: number;
  document: TuttiModePlanDocument;
}

export interface TuttiModePlanDocument {
  schema: string;
  phase: "configuration" | "task_graph";
  title: string;
  topicId: string;
  markdownBody: string;
  execution: TuttiModePlanExecution;
  budget: TuttiModePlanBudget;
  tasks: TuttiModePlanTask[];
}

export interface TuttiModePlanExecution {
  mode: "sequential" | "parallel";
  reasoningIntensity: number;
  orchestrationIntensity: number;
}

export interface TuttiModePlanBudget {
  mode: "auto" | "fixed";
  tokenLimit: number;
  quotaWaterlinePercent: number;
}

export interface TuttiModePlanTask {
  id: string;
  title: string;
  content: string;
  priority: "high" | "medium" | "low";
  agentTargetId?: string | null;
  modelPlanId?: string | null;
  model?: string | null;
  executionDirectory?: string | null;
  dependsOn: string[];
}

export interface TuttiModePlanCheckpoint {
  id: string;
  workflowId: string;
  kind: TuttiModePlanCheckpointKind;
  revisionId: string;
  status: TuttiModePlanCheckpointStatus;
  decidedBy?: string | null;
  decisionReason?: string | null;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  decidedAtUnixMs?: number | null;
}

export type TuttiModePlanPanelState =
  | "pending"
  | "accepted"
  | "rejected"
  | "canceled"
  | "expired";

export interface TuttiModePlanPanelRevisionViewModel {
  id: string;
  sequence: number;
  schemaVersion: string;
  documentPath: string;
  sha256: string;
  producedByTurnId: string | null;
  createdAtUnixMs: number;
}

export interface TuttiModePlanPanelCheckpointViewModel {
  id: string;
  status: TuttiModePlanCheckpointStatus;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAtUnixMs: number | null;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface TuttiModePlanPanelTaskViewModel {
  ordinal: number;
  id: string;
  title: string;
  content: string;
  priority: "high" | "medium" | "low";
  agentTargetId: string | null;
  modelPlanId: string | null;
  model: string | null;
  executionDirectory: string | null;
  dependsOn: string[];
}

export interface TuttiModePlanPanelViewModel {
  id: string;
  workflowId: string;
  workspaceId: string;
  sourceSessionId: string;
  sourceTurnId: string | null;
  sourceToolCallId: string | null;
  reviewKind: TuttiModePlanCheckpointKind;
  state: TuttiModePlanPanelState;
  actionable: boolean;
  title: string;
  topicId: string;
  markdownBody: string;
  revision: TuttiModePlanPanelRevisionViewModel;
  checkpoint: TuttiModePlanPanelCheckpointViewModel;
  execution: TuttiModePlanExecution;
  budget: TuttiModePlanBudget;
  tasks: TuttiModePlanPanelTaskViewModel[];
}

function nullableString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function checkpointSortValue(
  left: TuttiModePlanCheckpoint,
  right: TuttiModePlanCheckpoint
): number {
  return (
    left.updatedAtUnixMs - right.updatedAtUnixMs ||
    left.createdAtUnixMs - right.createdAtUnixMs ||
    left.id.localeCompare(right.id)
  );
}

function currentCheckpoint(
  snapshot: TuttiModePlanReviewSnapshot,
  revision: TuttiModePlanRevision
): TuttiModePlanCheckpoint | null {
  const checkpoints = snapshot.checkpoints
    .filter(
      (candidate) =>
        candidate.workflowId === snapshot.workflow.id &&
        candidate.revisionId === revision.id
    )
    .sort(checkpointSortValue);
  return checkpoints.at(-1) ?? null;
}

function reviewKindMatchesDocument(
  kind: TuttiModePlanCheckpointKind,
  phase: TuttiModePlanDocument["phase"]
): boolean {
  return (
    (kind === "configuration_review" && phase === "configuration") ||
    (kind === "task_review" && phase === "task_graph")
  );
}

function panelState(
  workflowStatus: TuttiModePlanWorkflowStatus,
  checkpointStatus: TuttiModePlanCheckpointStatus
): TuttiModePlanPanelState {
  switch (checkpointStatus) {
    case "accepted":
    case "rejected":
    case "canceled":
      return checkpointStatus;
    case "superseded":
      return "expired";
    case "pending":
      if (workflowStatus === "canceled") return "canceled";
      if (workflowStatus === "rejected") return "rejected";
      if (workflowStatus === "failed") return "expired";
      if (workflowStatus === "accepted" || workflowStatus === "completed") {
        return "accepted";
      }
      return "pending";
  }
}

function projectTask(
  task: TuttiModePlanTask,
  index: number
): TuttiModePlanPanelTaskViewModel {
  return {
    ordinal: index + 1,
    id: task.id,
    title: task.title,
    content: task.content,
    priority: task.priority,
    agentTargetId: nullableString(task.agentTargetId),
    modelPlanId: nullableString(task.modelPlanId),
    model: nullableString(task.model),
    executionDirectory: nullableString(task.executionDirectory),
    dependsOn: [...task.dependsOn]
  };
}

/**
 * Projects an authoritative, normalized workflow snapshot into the Tutti Mode
 * Plan review panel. The input is supplied by the workflow host boundary; this
 * function never reads transcript messages, provider interactions, or revision
 * files.
 */
export function projectTuttiModePlanPanel(
  snapshot: TuttiModePlanReviewSnapshot
): TuttiModePlanPanelViewModel | null {
  const workflow = snapshot.workflow;
  if (
    workflow.type !== "tutti_mode_plan" ||
    workflow.owner !== "tutti" ||
    workflow.triggerKind !== "agent_cli"
  ) {
    return null;
  }

  const revision = snapshot.revisions.find(
    (candidate) =>
      candidate.id === workflow.currentRevisionId &&
      candidate.workflowId === workflow.id
  );
  if (!revision || revision.document.schema !== revision.schemaVersion) {
    return null;
  }

  const checkpoint = currentCheckpoint(snapshot, revision);
  if (
    !checkpoint ||
    !reviewKindMatchesDocument(checkpoint.kind, revision.document.phase)
  ) {
    return null;
  }

  const state = panelState(workflow.status, checkpoint.status);
  return {
    id: `${workflow.id}:${checkpoint.id}`,
    workflowId: workflow.id,
    workspaceId: workflow.workspaceId,
    sourceSessionId: workflow.sourceSessionId,
    sourceTurnId: nullableString(workflow.sourceTurnId),
    sourceToolCallId: nullableString(workflow.sourceToolCallId),
    reviewKind: checkpoint.kind,
    state,
    actionable: state === "pending",
    title: revision.document.title,
    topicId: revision.document.topicId,
    markdownBody: revision.document.markdownBody,
    revision: {
      id: revision.id,
      sequence: revision.sequence,
      schemaVersion: revision.schemaVersion,
      documentPath: revision.documentPath,
      sha256: revision.sha256,
      producedByTurnId: nullableString(revision.producedByTurnId),
      createdAtUnixMs: revision.createdAtUnixMs
    },
    checkpoint: {
      id: checkpoint.id,
      status: checkpoint.status,
      decidedBy: nullableString(checkpoint.decidedBy),
      decisionReason: nullableString(checkpoint.decisionReason),
      decidedAtUnixMs: checkpoint.decidedAtUnixMs ?? null,
      createdAtUnixMs: checkpoint.createdAtUnixMs,
      updatedAtUnixMs: checkpoint.updatedAtUnixMs
    },
    execution: { ...revision.document.execution },
    budget: { ...revision.document.budget },
    tasks: revision.document.tasks.map(projectTask)
  };
}
