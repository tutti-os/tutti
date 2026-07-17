import { createContext, useContext, type JSX, type ReactNode } from "react";
import type { TuttiModePlanReviewSnapshot } from "./tuttiModePlan/tuttiModePlanPanelProjection";

export interface TuttiModePlanReviewUpdate {
  kind: "workflow_updated";
  workspaceId: string;
  workflowId: string;
  sourceSessionId: string;
  checkpointId: string;
  changeKind:
    | "proposal_created"
    | "revision_created"
    | "checkpoint_decided"
    | "operation_updated";
}

export interface TuttiModePlanReviewConnectionRestored {
  kind: "connection_restored";
  workspaceId: string;
}

export type TuttiModePlanReviewInvalidation =
  | TuttiModePlanReviewUpdate
  | TuttiModePlanReviewConnectionRestored;

export interface TuttiModePlanTaskAssignmentInput {
  taskId: string;
  agentTargetId?: string | null;
  modelPlanId?: string | null;
  model?: string | null;
  permissionModeId?: string | null;
  reasoningEffort?: string | null;
}

export interface TuttiModePlanReviewDecisionInput {
  workspaceId: string;
  workflowId: string;
  checkpointId: string;
  decision: "accepted" | "rejected" | "canceled";
  decidedBy: string;
  reason?: string | null;
  /** Per-task overrides; only meaningful with an accepted task review. */
  taskAssignments?: readonly TuttiModePlanTaskAssignmentInput[];
}

export interface TuttiModePlanAssignmentAgentOption {
  agentTargetId: string;
  label: string;
}

export interface TuttiModePlanAssignmentAgentDetail {
  /** Provider-native models usable without a model plan. */
  models: readonly string[];
  modelPlans: readonly {
    modelPlanId: string;
    label: string;
    models: readonly string[];
  }[];
  permissionModes: readonly { id: string; label: string }[];
  reasoningEfforts: readonly string[];
}

/**
 * Option catalogs for per-task assignment editing. The desktop host reuses
 * its agent directory and composer capability catalogs; the panel never
 * hardcodes providers or modes.
 */
export interface TuttiModePlanAssignmentOptionsSource {
  listAgents(input: {
    workspaceId: string;
  }): Promise<readonly TuttiModePlanAssignmentAgentOption[]>;
  loadAgentOptions(input: {
    workspaceId: string;
    agentTargetId: string;
  }): Promise<TuttiModePlanAssignmentAgentDetail>;
}

export interface TuttiModePlanReviewRuntime {
  listPending(input: {
    workspaceId: string;
    sourceSessionId: string;
  }): Promise<readonly TuttiModePlanReviewSnapshot[]>;
  decide(input: TuttiModePlanReviewDecisionInput): Promise<void>;
  subscribe(
    workspaceId: string,
    listener: (update: TuttiModePlanReviewInvalidation) => void
  ): () => void;
  /** Optional; the panel degrades to read-only assignment display without it. */
  assignmentOptions?: TuttiModePlanAssignmentOptionsSource;
}

const TuttiModePlanReviewRuntimeContext =
  createContext<TuttiModePlanReviewRuntime | null>(null);

export function TuttiModePlanReviewRuntimeProvider({
  children,
  runtime
}: {
  children: ReactNode;
  runtime?: TuttiModePlanReviewRuntime | null;
}): JSX.Element {
  return (
    <TuttiModePlanReviewRuntimeContext.Provider value={runtime ?? null}>
      {children}
    </TuttiModePlanReviewRuntimeContext.Provider>
  );
}

export function useOptionalTuttiModePlanReviewRuntime(): TuttiModePlanReviewRuntime | null {
  return useContext(TuttiModePlanReviewRuntimeContext);
}
