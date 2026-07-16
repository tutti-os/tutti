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

export interface TuttiModePlanReviewDecisionInput {
  workspaceId: string;
  workflowId: string;
  checkpointId: string;
  decision: "accepted" | "rejected" | "canceled";
  decidedBy: string;
  reason?: string | null;
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
