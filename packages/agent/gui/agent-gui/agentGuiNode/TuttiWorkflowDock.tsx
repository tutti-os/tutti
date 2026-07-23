import { useState } from "react";
import {
  AlertTriangle,
  Gauge,
  ListChecks,
  LoaderCircle,
  RotateCcw,
  X
} from "lucide-react";
import { TaskIcon } from "@tutti-os/ui-system/icons";
import {
  TuttiModePlanPanel,
  TuttiPlanIssuePanel,
  type TuttiModePlanAssignmentCatalog,
  type TuttiModePlanPanelLabels,
  type TuttiModePlanPanelViewModel,
  type TuttiModePlanTaskAssignmentDraft,
  type TuttiModePlanTaskAssignmentDrafts,
  type TuttiPlanIssuePanelLabels,
  type TuttiPlanIssueSnapshot,
  type TuttiPlanIssueTaskDecision
} from "../../workspaceWorkflow";
import { cn } from "../../app/renderer/lib/utils";
import { AgentComposerDisclosureCard } from "./AgentComposerDisclosureCard";
import {
  TuttiBudgetPopover,
  type TuttiBudgetPopoverLabels
} from "./composer/TuttiBudgetPopover";

export type TuttiWorkflowDockPhase =
  | {
      kind: "review";
      intensity: number;
      intensityDiverged: boolean;
      panel: TuttiModePlanPanelViewModel;
      submitting: boolean;
    }
  | {
      kind: "materializing";
      title: string;
    }
  | {
      issue: TuttiPlanIssueSnapshot;
      kind: "execution";
    }
  | {
      kind: "error";
      message: string;
      retryable: boolean;
    };

export interface TuttiWorkflowDockLabels {
  cancel: string;
  collapse: string;
  errorTitle: string;
  expand: string;
  issueDone(done: string, total: string): string;
  issueFailed(count: string): string;
  issuePendingAcceptance(count: string): string;
  issueRunning(count: string): string;
  materializingHint: string;
  materializingTitle: string;
  retry: string;
  reviewHint: string;
  reviewHintReplan: string;
  reviewTitle: string;
}

interface TuttiWorkflowDockDisclosureState {
  expanded: boolean;
  reviewPanelId: string | null;
}

function countIssueTasks(
  issue: TuttiPlanIssueSnapshot,
  status: string
): number {
  return issue.tasks.filter((task) => task.status === status).length;
}

function issueSummary(
  labels: TuttiWorkflowDockLabels,
  issue: TuttiPlanIssueSnapshot
): string {
  const running = countIssueTasks(issue, "running");
  const pendingAcceptance = countIssueTasks(issue, "pending_acceptance");
  const failed = countIssueTasks(issue, "failed");
  const done = countIssueTasks(issue, "completed");
  const parts: string[] = [];
  if (running > 0) parts.push(labels.issueRunning(String(running)));
  if (pendingAcceptance > 0) {
    parts.push(labels.issuePendingAcceptance(String(pendingAcceptance)));
  }
  if (failed > 0) parts.push(labels.issueFailed(String(failed)));
  parts.push(labels.issueDone(String(done), String(issue.tasks.length)));
  return parts.join(" · ");
}

/**
 * Single composer-anchored projection for the active Tutti workflow.
 *
 * The disclosure shell stays mounted while its phase moves from review to
 * materialization and execution. Only one current panel is rendered, so the
 * conversation timeline never competes with a second plan or task surface.
 */
export function TuttiWorkflowDock({
  assignmentCatalog,
  assignmentDrafts,
  intensityPopoverLabels,
  labels,
  onAssignmentDraftChange,
  onCancelExecution,
  onCancelReview,
  onDecideTask,
  onIntensityChange,
  onOpenIssue,
  onOpenTask,
  onRetry,
  phase,
  planPanelLabels,
  planIssuePanelLabels
}: {
  assignmentCatalog: TuttiModePlanAssignmentCatalog;
  assignmentDrafts: TuttiModePlanTaskAssignmentDrafts;
  intensityPopoverLabels: TuttiBudgetPopoverLabels;
  labels: TuttiWorkflowDockLabels;
  onAssignmentDraftChange(
    taskId: string,
    patch: TuttiModePlanTaskAssignmentDraft
  ): void;
  onCancelExecution?: () => Promise<void>;
  onCancelReview(): void;
  onDecideTask?: (
    taskId: string,
    decision: TuttiPlanIssueTaskDecision
  ) => Promise<void>;
  onIntensityChange(value: number): void;
  onOpenIssue?: () => void;
  onOpenTask?: (taskId: string) => void | Promise<void>;
  onRetry(): void;
  phase: TuttiWorkflowDockPhase;
  planPanelLabels: TuttiModePlanPanelLabels;
  planIssuePanelLabels: TuttiPlanIssuePanelLabels;
}): React.JSX.Element {
  const review = phase.kind === "review" ? phase : null;
  const execution = phase.kind === "execution" ? phase : null;
  const failure = phase.kind === "error" ? phase : null;
  const reviewPanelId = review?.panel.id ?? null;
  const [disclosure, setDisclosure] =
    useState<TuttiWorkflowDockDisclosureState>(() => ({
      expanded: reviewPanelId !== null,
      reviewPanelId
    }));

  // A newly actionable checkpoint starts open once. Recording its stable panel
  // identity prevents ordinary snapshot updates from overriding a user's
  // explicit collapse, while phase handoffs retain the current disclosure.
  if (reviewPanelId !== null && reviewPanelId !== disclosure.reviewPanelId) {
    setDisclosure({ expanded: true, reviewPanelId });
  }
  const setExpanded = (expanded: boolean): void => {
    setDisclosure((current) =>
      current.expanded === expanded ? current : { ...current, expanded }
    );
  };

  const title =
    review !== null
      ? labels.reviewTitle
      : phase.kind === "materializing"
        ? labels.materializingTitle
        : execution !== null
          ? execution.issue.title
          : labels.errorTitle;
  const summary =
    review !== null
      ? `${review.panel.title} · ${
          review.intensityDiverged ? labels.reviewHintReplan : labels.reviewHint
        }`
      : phase.kind === "materializing"
        ? `${phase.title} · ${labels.materializingHint}`
        : execution !== null
          ? issueSummary(labels, execution.issue)
          : (failure?.message ?? "");
  const icon =
    review !== null ? (
      <TaskIcon aria-hidden className="size-3.5" />
    ) : phase.kind === "materializing" ? (
      <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
    ) : execution !== null ? (
      countIssueTasks(execution.issue, "running") > 0 ? (
        <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
      ) : (
        <ListChecks aria-hidden className="size-3.5" />
      )
    ) : (
      <AlertTriangle aria-hidden className="size-3.5" />
    );

  const actions =
    review !== null ? (
      <>
        <TuttiBudgetPopover
          intensity={review.intensity}
          labels={intensityPopoverLabels}
          onConfirm={onIntensityChange}
        >
          <button
            type="button"
            disabled={review.submitting}
            title={intensityPopoverLabels.title}
            aria-label={intensityPopoverLabels.intensityLabel}
            data-testid="agent-gui-tutti-workflow-intensity"
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors",
              "hover:bg-[var(--transparency-hover)]",
              "data-[state=open]:bg-[color-mix(in_srgb,var(--tutti-purple)_12%,transparent)] data-[state=open]:text-[var(--tutti-purple)]",
              review.intensityDiverged && "text-[var(--tutti-purple)]"
            )}
          >
            <Gauge aria-hidden className="size-3.5" />
            <span className="text-[11px] tabular-nums">{review.intensity}</span>
          </button>
        </TuttiBudgetPopover>
        <button
          type="button"
          disabled={review.submitting}
          onClick={onCancelReview}
          title={labels.cancel}
          aria-label={labels.cancel}
          data-testid="agent-gui-tutti-workflow-cancel"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </>
    ) : phase.kind === "error" && phase.retryable ? (
      <button
        type="button"
        onClick={onRetry}
        title={labels.retry}
        aria-label={labels.retry}
        data-testid="agent-gui-tutti-workflow-retry"
      >
        <RotateCcw aria-hidden className="size-3.5" />
        {labels.retry}
      </button>
    ) : null;

  return (
    <AgentComposerDisclosureCard
      actions={actions}
      expanded={disclosure.expanded}
      icon={icon}
      labels={{ collapse: labels.collapse, expand: labels.expand }}
      onExpandedChange={setExpanded}
      summary={summary}
      testId="agent-gui-tutti-workflow-dock"
      title={title}
    >
      {review !== null ? (
        <TuttiModePlanPanel
          assignmentCatalog={assignmentCatalog}
          assignmentDrafts={assignmentDrafts}
          embedded={true}
          labels={planPanelLabels}
          panel={review.panel}
          submitting={review.submitting}
          onAssignmentDraftChange={onAssignmentDraftChange}
        />
      ) : phase.kind === "materializing" ? (
        <div
          className="grid min-h-28 place-items-center gap-2 text-center text-sm text-muted-foreground"
          role="status"
        >
          <LoaderCircle
            aria-hidden
            className="size-5 animate-spin text-[var(--tutti-purple)]"
          />
          <span>{labels.materializingHint}</span>
        </div>
      ) : execution !== null ? (
        <TuttiPlanIssuePanel
          embedded={true}
          issue={execution.issue}
          labels={planIssuePanelLabels}
          onCancelExecution={onCancelExecution}
          onDecideTask={onDecideTask}
          onOpenIssue={onOpenIssue}
          onOpenTask={onOpenTask}
        />
      ) : (
        <div
          className="rounded-md border border-[color-mix(in_srgb,var(--state-danger)_45%,transparent)] px-4 py-3 text-sm text-muted-foreground"
          role="alert"
        >
          {failure?.message}
        </div>
      )}
    </AgentComposerDisclosureCard>
  );
}
