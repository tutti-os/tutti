import { useState } from "react";
import {
  AlertTriangle,
  Gauge,
  ListChecks,
  LoaderCircle,
  RotateCcw,
  X
} from "lucide-react";
import { Button } from "@tutti-os/ui-system";
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
  type TuttiPlanIssueTaskAction
} from "../../workspaceWorkflow";
import { cn } from "../../app/renderer/lib/utils";
import { AgentComposerDisclosureCard } from "./AgentComposerDisclosureCard";
import styles from "./AgentGUIChrome.styles";
import {
  TuttiBudgetPopover,
  type TuttiBudgetPopoverLabels
} from "./composer/TuttiBudgetPopover";
import { projectTuttiPreferencePreview } from "./composer/tuttiIntensityPreview";

export type TuttiWorkflowDockPhase =
  | {
      kind: "review";
      effect: number;
      speed: number;
      preferencesDiverged: boolean;
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
    }
  | {
      kind: "reviewFailure";
      message: string;
      auditId?: string;
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
  switchToSelfReview: string;
  switchingToSelfReview: string;
  selfReviewEnabled: string;
  selfReviewFailed: string;
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
  preferencePopoverLabels,
  labels,
  onAssignmentDraftChange,
  onCancelReview,
  onTaskAction,
  onEffectChange,
  onSpeedChange,
  onOpenIssue,
  onOpenTask,
  onRetry,
  onSwitchToSelfReview,
  phase,
  planPanelLabels,
  planIssuePanelLabels
}: {
  assignmentCatalog: TuttiModePlanAssignmentCatalog;
  assignmentDrafts: TuttiModePlanTaskAssignmentDrafts;
  preferencePopoverLabels: TuttiBudgetPopoverLabels;
  labels: TuttiWorkflowDockLabels;
  onAssignmentDraftChange(
    taskId: string,
    patch: TuttiModePlanTaskAssignmentDraft
  ): void;
  onCancelReview(): void;
  onTaskAction?: (
    taskId: string,
    action: TuttiPlanIssueTaskAction
  ) => Promise<void>;
  onEffectChange(value: number): void;
  onSpeedChange(value: number): void;
  onOpenIssue?: () => void;
  onOpenTask?: (taskId: string) => void | Promise<void>;
  onRetry(): void;
  onSwitchToSelfReview?: () => Promise<void>;
  phase: TuttiWorkflowDockPhase;
  planPanelLabels: TuttiModePlanPanelLabels;
  planIssuePanelLabels: TuttiPlanIssuePanelLabels;
}): React.JSX.Element {
  const review = phase.kind === "review" ? phase : null;
  const execution = phase.kind === "execution" ? phase : null;
  const failure = phase.kind === "error" ? phase : null;
  const reviewFailure = phase.kind === "reviewFailure" ? phase : null;
  const [selfReviewState, setSelfReviewState] = useState<
    "idle" | "switching" | "enabled" | "failed"
  >("idle");
  const reviewPanelId = review?.panel.id ?? null;
  const [disclosure, setDisclosure] =
    useState<TuttiWorkflowDockDisclosureState>(() => ({
      expanded: reviewPanelId !== null,
      reviewPanelId
    }));
  // Echo preferences just dragged until canonical composer state catches up
  // (review preference updates travel through an async daemon command),
  // so the banner and the open popover never display diverging values. The
  // echo clears during render (same adjustment pattern as the disclosure
  // above) once the canonical value matches.
  const [echoedEffect, setEchoedEffect] = useState<number | null>(null);
  const [echoedSpeed, setEchoedSpeed] = useState<number | null>(null);
  if (echoedEffect !== null && review?.effect === echoedEffect) {
    setEchoedEffect(null);
  }
  if (echoedSpeed !== null && review?.speed === echoedSpeed) {
    setEchoedSpeed(null);
  }
  const reviewDisplayEffect =
    review !== null ? (echoedEffect ?? review.effect) : null;
  const reviewDisplaySpeed =
    review !== null ? (echoedSpeed ?? review.speed) : null;
  const handleEffectChange = (value: number): void => {
    setEchoedEffect(value);
    onEffectChange(value);
  };
  const handleSpeedChange = (value: number): void => {
    setEchoedSpeed(value);
    onSpeedChange(value);
  };

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
          review.preferencesDiverged
            ? labels.reviewHintReplan
            : labels.reviewHint
        }`
      : phase.kind === "materializing"
        ? `${phase.title} · ${labels.materializingHint}`
        : execution !== null
          ? issueSummary(labels, execution.issue)
          : (failure?.message ??
            (reviewFailure
              ? `${reviewFailure.message}${reviewFailure.auditId ? ` · ${reviewFailure.auditId}` : ""}`
              : ""));
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

  const reviewTier =
    reviewDisplayEffect !== null && reviewDisplaySpeed !== null
      ? projectTuttiPreferencePreview(reviewDisplayEffect, reviewDisplaySpeed)
          .effectTier
      : null;

  const actions =
    review !== null ? (
      <>
        <TuttiBudgetPopover
          effect={reviewDisplayEffect ?? review.effect}
          speed={reviewDisplaySpeed ?? review.speed}
          labels={preferencePopoverLabels}
          onEffectChange={handleEffectChange}
          onSpeedChange={handleSpeedChange}
        >
          <button
            type="button"
            disabled={review.submitting}
            title={preferencePopoverLabels.title}
            aria-label={preferencePopoverLabels.title}
            data-agent-tutti-tier={reviewTier ?? undefined}
            data-testid="agent-gui-tutti-workflow-intensity"
            className={cn(
              "flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] transition-colors",
              "data-[state=open]:bg-[color-mix(in_srgb,var(--tutti-purple)_12%,transparent)] data-[state=open]:text-[var(--tutti-purple)]"
            )}
          >
            <Gauge aria-hidden className="size-3.5" />
            {/*
              All tier labels occupy the same grid cell so the chip width is
              always the longest label's width; switching tiers while the
              slider moves no longer resizes the chip or shifts the anchored
              popover. Icon, label, and value share one container with a
              uniform 4px gap.
            */}
            <span className="grid">
              {(
                [
                  ["cost", preferencePopoverLabels.previewCost],
                  ["balance", preferencePopoverLabels.previewBalance],
                  ["powerful", preferencePopoverLabels.previewPowerful]
                ] as const
              ).map(([tier, label]) => (
                <span
                  key={tier}
                  aria-hidden={tier !== reviewTier}
                  className={
                    tier === reviewTier
                      ? "[grid-area:1/1]"
                      : "invisible [grid-area:1/1]"
                  }
                >
                  {label}
                </span>
              ))}
            </span>
            <span className="inline-block w-[7ch] text-left text-[11px] tabular-nums">
              {reviewDisplayEffect ?? review.effect}/
              {reviewDisplaySpeed ?? review.speed}
            </span>
          </button>
        </TuttiBudgetPopover>
        <button
          type="button"
          disabled={review.submitting}
          onClick={onCancelReview}
          title={labels.cancel}
          aria-label={labels.cancel}
          data-testid="agent-gui-tutti-workflow-cancel"
          className="flex size-5 items-center justify-center rounded-md transition-colors hover:bg-[var(--transparency-hover)]"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </>
    ) : reviewFailure ? (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={
          !onSwitchToSelfReview ||
          selfReviewState === "switching" ||
          selfReviewState === "enabled"
        }
        onClick={() => {
          if (!onSwitchToSelfReview) {
            return;
          }
          setSelfReviewState("switching");
          void onSwitchToSelfReview().then(
            () => setSelfReviewState("enabled"),
            () => setSelfReviewState("failed")
          );
        }}
      >
        {selfReviewState === "switching"
          ? labels.switchingToSelfReview
          : selfReviewState === "enabled"
            ? labels.selfReviewEnabled
            : labels.switchToSelfReview}
      </Button>
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
      bannerClassName={styles.tuttiWorkflowBanner}
      expanded={disclosure.expanded}
      icon={icon}
      labels={{ collapse: labels.collapse, expand: labels.expand }}
      panelClassName={styles.tuttiWorkflowPanel}
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
          onTaskAction={onTaskAction}
          onOpenIssue={onOpenIssue}
          onOpenTask={onOpenTask}
        />
      ) : (
        <div
          className="rounded-md border border-[color-mix(in_srgb,var(--state-danger)_45%,transparent)] px-4 py-3 text-sm text-muted-foreground"
          role="alert"
        >
          <span>{failure?.message ?? reviewFailure?.message}</span>
          {reviewFailure?.auditId ? (
            <span className="mt-2 block text-xs">{reviewFailure.auditId}</span>
          ) : null}
          {selfReviewState === "failed" ? (
            <span className="mt-2 block text-xs">
              {labels.selfReviewFailed}
            </span>
          ) : null}
        </div>
      )}
    </AgentComposerDisclosureCard>
  );
}
