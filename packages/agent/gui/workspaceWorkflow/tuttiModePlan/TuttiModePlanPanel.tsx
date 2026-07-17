import { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Slider,
  Textarea,
  cn
} from "@tutti-os/ui-system";
import composerStyles from "../../agent-gui/agentGuiNode/AgentGUINode.styles";
import type { TuttiModePlanTaskAssignmentInput } from "../workspaceWorkflowRuntime";
import type {
  TuttiModePlanPanelTaskViewModel,
  TuttiModePlanPanelViewModel
} from "./tuttiModePlanPanelProjection";
import type { TuttiModePlanAssignmentCatalog } from "./useTuttiModePlanPanels";
import {
  TuttiModePlanTaskAssignmentEditor,
  permissionModeAssignmentTone
} from "./TuttiModePlanTaskAssignmentEditor";
import {
  mergeTaskAssignmentDraft,
  taskAssignmentInputsFromDrafts,
  type TuttiModePlanTaskAssignmentDrafts
} from "./tuttiModePlanTaskAssignments";

export interface TuttiModePlanPanelLabels {
  mode: string;
  taskReview: string;
  pending: string;
  accept: string;
  requestChanges: string;
  cancel: string;
  feedbackPlaceholder: string;
  submitFeedback: string;
  feedbackRequired: string;
  tasks: string;
  execution: string;
  budget: string;
  orchestrationIntensity: string;
  quotaWaterline: string;
  priority: string;
  priorityHigh: string;
  priorityMedium: string;
  priorityLow: string;
  agentTarget: string;
  modelPlan: string;
  model: string;
  permissionMode: string;
  reasoningEffort: string;
  notSpecified: string;
  assignmentOptionsLoading: string;
}

export function TuttiModePlanPanel({
  assignmentCatalog,
  labels,
  orchestrationIntensity,
  panel,
  submitting,
  onDecide,
  onOrchestrationIntensityChange
}: {
  assignmentCatalog?: TuttiModePlanAssignmentCatalog | null;
  labels: TuttiModePlanPanelLabels;
  /**
   * Live session value backing the composer's Tutti badge popover; the panel
   * slider reads and writes the same setting so the two stay in sync. Omit to
   * fall back to the plan document's snapshot, read-only.
   */
  orchestrationIntensity?: number | null;
  panel: TuttiModePlanPanelViewModel;
  submitting: boolean;
  onDecide(input: {
    checkpointId: string;
    decision: "accepted" | "rejected" | "canceled";
    reason?: string | null;
    taskAssignments?: readonly TuttiModePlanTaskAssignmentInput[];
    workflowId: string;
  }): Promise<void>;
  onOrchestrationIntensityChange?(value: number): void;
}): React.JSX.Element {
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [feedbackMissing, setFeedbackMissing] = useState(false);
  const [assignmentDrafts, setAssignmentDrafts] =
    useState<TuttiModePlanTaskAssignmentDrafts>({});
  // Editing needs the loaded agent directory; before that (or without a host
  // catalog at all) tasks stay read-only.
  const editable = assignmentCatalog?.agents != null && panel.actionable;
  const decide = (
    decision: "accepted" | "rejected" | "canceled",
    reason?: string
  ) => {
    const taskAssignments =
      decision === "accepted"
        ? taskAssignmentInputsFromDrafts(assignmentDrafts, panel.tasks)
        : [];
    return onDecide({
      workflowId: panel.workflowId,
      checkpointId: panel.checkpoint.id,
      decision,
      reason,
      taskAssignments: taskAssignments.length > 0 ? taskAssignments : undefined
    });
  };

  return (
    <Card
      className="mx-auto w-full max-w-[860px]"
      data-testid="tutti-mode-plan-panel"
    >
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="accent">{labels.mode}</Badge>
          <Badge variant="pending">{labels.pending}</Badge>
          <span className="text-xs text-muted-foreground">
            {labels.taskReview}
          </span>
        </div>
        <CardTitle>{panel.title}</CardTitle>
        <CardDescription>{panel.topicId}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="prose prose-sm max-w-none text-foreground dark:prose-invert">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
          >
            {panel.markdownBody}
          </ReactMarkdown>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <section className="grid gap-3 rounded-md border border-border/70 bg-muted/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-medium text-foreground">
                {labels.execution}
              </h4>
            </div>
            <OrchestrationIntensityField
              label={labels.orchestrationIntensity}
              value={
                orchestrationIntensity ?? panel.execution.orchestrationIntensity
              }
              onChange={
                panel.actionable && !submitting
                  ? onOrchestrationIntensityChange
                  : undefined
              }
            />
          </section>
          <section className="grid gap-3 rounded-md border border-border/70 bg-muted/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-medium text-foreground">
                {labels.budget}
              </h4>
            </div>
            <dl className="grid gap-2 text-xs">
              <DefinitionItem
                label={labels.quotaWaterline}
                value={`${panel.budget.quotaWaterlinePercent}%`}
              />
            </dl>
          </section>
        </div>
        {panel.tasks.length > 0 ? (
          <section className="grid gap-2">
            <h4 className="text-xs font-medium text-foreground">
              {labels.tasks}
            </h4>
            <ol className="grid gap-2">
              {panel.tasks.map((task) => (
                <li
                  key={task.id}
                  className="rounded-md bg-muted/60 px-3 py-2 text-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="font-medium text-foreground">
                      {task.ordinal}. {task.title}
                    </div>
                    <Badge variant="secondary">
                      {priorityLabel(labels, task.priority)}
                    </Badge>
                  </div>
                  {task.content ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {task.content}
                    </p>
                  ) : null}
                  {editable && assignmentCatalog ? (
                    <TuttiModePlanTaskAssignmentEditor
                      catalog={assignmentCatalog}
                      disabled={submitting}
                      draft={assignmentDrafts[task.id] ?? {}}
                      labels={labels}
                      task={task}
                      onEdit={(patch) =>
                        setAssignmentDrafts((current) =>
                          mergeTaskAssignmentDraft(current, task.id, patch)
                        )
                      }
                    />
                  ) : (
                    <TaskAssignmentSummary labels={labels} task={task} />
                  )}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {requestingChanges ? (
          <div className="grid gap-2">
            <Textarea
              aria-invalid={feedbackMissing || undefined}
              value={feedback}
              placeholder={labels.feedbackPlaceholder}
              onChange={(event) => {
                setFeedback(event.currentTarget.value);
                setFeedbackMissing(false);
              }}
            />
            {feedbackMissing ? (
              <p className="text-xs text-destructive" role="alert">
                {labels.feedbackRequired}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={submitting}
          onClick={() => void decide("canceled")}
        >
          {labels.cancel}
        </Button>
        {requestingChanges ? (
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={() => {
              const reason = feedback.trim();
              if (!reason) {
                setFeedbackMissing(true);
                return;
              }
              void decide("rejected", reason);
            }}
          >
            {labels.submitFeedback}
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={() => setRequestingChanges(true)}
          >
            {labels.requestChanges}
          </Button>
        )}
        <Button
          type="button"
          disabled={submitting}
          onClick={() => void decide("accepted")}
        >
          {labels.accept}
        </Button>
      </CardFooter>
    </Card>
  );
}

/**
 * Orchestration-intensity slider mirroring the composer's Tutti budget
 * popover row (label left, tabular value right, slider below). The local
 * draft only covers mid-drag rendering: committed values echo back
 * synchronously through the activation engine, so the draft clears on
 * commit. Without an `onChange` the slider is a disabled display.
 */
function OrchestrationIntensityField({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange?: ((value: number) => void) | undefined;
}): React.JSX.Element {
  const [dragValue, setDragValue] = useState<number | null>(null);
  const displayValue = dragValue ?? value;
  return (
    <div className="nodrag grid gap-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span
          className="tabular-nums text-foreground"
          data-tutti-plan-orchestration-intensity-value="true"
        >
          {displayValue}
        </span>
      </div>
      <Slider
        aria-label={label}
        disabled={onChange === undefined}
        max={100}
        min={0}
        step={1}
        value={[displayValue]}
        onValueChange={(values) => setDragValue(values[0] ?? null)}
        onValueCommit={(values) => {
          setDragValue(null);
          const next = values[0];
          if (next !== undefined) onChange?.(next);
        }}
      />
    </div>
  );
}

function DefinitionItem({
  label,
  value
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

/**
 * Read-only counterpart of the assignment editor row: the same composer-styled
 * single line, showing only the assignments the plan actually specifies.
 */
function TaskAssignmentSummary({
  labels,
  task
}: {
  labels: TuttiModePlanPanelLabels;
  task: TuttiModePlanPanelTaskViewModel;
}): React.JSX.Element | null {
  const chips: {
    label: string;
    tone?: "accent" | "success" | "warning" | undefined;
    value: string | null;
  }[] = [
    { label: labels.agentTarget, value: task.agentTargetId },
    { label: labels.modelPlan, value: task.modelPlanId },
    { label: labels.model, value: task.model },
    {
      label: labels.permissionMode,
      tone: permissionModeAssignmentTone(task.permissionModeId),
      value: task.permissionModeId
    },
    { label: labels.reasoningEffort, value: task.reasoningEffort }
  ].filter((chip) => chip.value !== null);
  if (chips.length === 0) {
    return null;
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-0.5 border-t border-border/70 pt-2">
      {chips.map((chip) => (
        <span
          key={chip.label}
          title={chip.label}
          data-permission-tone={chip.tone}
          className={cn(
            "w-auto max-w-full",
            composerStyles.composerMenuTrigger
          )}
        >
          <span className="min-w-0 truncate">{chip.value}</span>
        </span>
      ))}
    </div>
  );
}

function priorityLabel(
  labels: TuttiModePlanPanelLabels,
  priority: TuttiModePlanPanelViewModel["tasks"][number]["priority"]
): string {
  switch (priority) {
    case "high":
      return labels.priorityHigh;
    case "medium":
      return labels.priorityMedium;
    case "low":
      return labels.priorityLow;
  }
}
