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
  Textarea
} from "@tutti-os/ui-system";
import type { TuttiModePlanPanelViewModel } from "./tuttiModePlanPanelProjection";

export interface TuttiModePlanPanelLabels {
  mode: string;
  configurationReview: string;
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
  executionSequential: string;
  executionParallel: string;
  budget: string;
  budgetAuto: string;
  budgetFixed: string;
  reasoningIntensity: string;
  orchestrationIntensity: string;
  tokenLimit: string;
  quotaWaterline: string;
  taskId: string;
  priority: string;
  priorityHigh: string;
  priorityMedium: string;
  priorityLow: string;
  agentTarget: string;
  modelPlan: string;
  model: string;
  executionDirectory: string;
  dependencies: string;
  notSpecified: string;
  none: string;
}

export function TuttiModePlanPanel({
  labels,
  panel,
  submitting,
  onDecide
}: {
  labels: TuttiModePlanPanelLabels;
  panel: TuttiModePlanPanelViewModel;
  submitting: boolean;
  onDecide(input: {
    checkpointId: string;
    decision: "accepted" | "rejected" | "canceled";
    reason?: string | null;
    workflowId: string;
  }): Promise<void>;
}): React.JSX.Element {
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [feedbackMissing, setFeedbackMissing] = useState(false);
  const reviewLabel =
    panel.reviewKind === "configuration_review"
      ? labels.configurationReview
      : labels.taskReview;
  const executionLabel =
    panel.execution.mode === "sequential"
      ? labels.executionSequential
      : labels.executionParallel;
  const budgetLabel =
    panel.budget.mode === "auto" ? labels.budgetAuto : labels.budgetFixed;
  const decide = (
    decision: "accepted" | "rejected" | "canceled",
    reason?: string
  ) =>
    onDecide({
      workflowId: panel.workflowId,
      checkpointId: panel.checkpoint.id,
      decision,
      reason
    });

  return (
    <Card
      className="mx-auto w-full max-w-[860px]"
      data-testid="tutti-mode-plan-panel"
    >
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="accent">{labels.mode}</Badge>
          <Badge variant="pending">{labels.pending}</Badge>
          <span className="text-xs text-muted-foreground">{reviewLabel}</span>
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
              <Badge variant="secondary">{executionLabel}</Badge>
            </div>
            <dl className="grid gap-2 text-xs">
              <DefinitionItem
                label={labels.reasoningIntensity}
                value={`${panel.execution.reasoningIntensity} / 100`}
              />
              <DefinitionItem
                label={labels.orchestrationIntensity}
                value={`${panel.execution.orchestrationIntensity} / 100`}
              />
            </dl>
          </section>
          <section className="grid gap-3 rounded-md border border-border/70 bg-muted/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-medium text-foreground">
                {labels.budget}
              </h4>
              <Badge variant="secondary">{budgetLabel}</Badge>
            </div>
            <dl className="grid gap-2 text-xs">
              <DefinitionItem
                label={labels.tokenLimit}
                value={panel.budget.tokenLimit.toLocaleString()}
              />
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
                  <dl className="mt-3 grid gap-x-4 gap-y-2 border-t border-border/70 pt-3 text-xs sm:grid-cols-2">
                    <DefinitionItem
                      label={labels.taskId}
                      value={task.id}
                      monospace
                    />
                    <DefinitionItem
                      label={labels.priority}
                      value={priorityLabel(labels, task.priority)}
                    />
                    <DefinitionItem
                      label={labels.agentTarget}
                      value={task.agentTargetId ?? labels.notSpecified}
                      monospace={task.agentTargetId !== null}
                    />
                    <DefinitionItem
                      label={labels.modelPlan}
                      value={task.modelPlanId ?? labels.notSpecified}
                      monospace={task.modelPlanId !== null}
                    />
                    <DefinitionItem
                      label={labels.model}
                      value={task.model ?? labels.notSpecified}
                      monospace={task.model !== null}
                    />
                    <DefinitionItem
                      label={labels.executionDirectory}
                      value={task.executionDirectory ?? labels.notSpecified}
                      monospace={task.executionDirectory !== null}
                    />
                    <div className="grid gap-1 sm:col-span-2">
                      <dt className="text-muted-foreground">
                        {labels.dependencies}
                      </dt>
                      <dd className="flex flex-wrap gap-1 text-foreground">
                        {task.dependsOn.length > 0
                          ? task.dependsOn.map((dependency) => (
                              <Badge
                                key={dependency}
                                variant="outline"
                                className="font-mono"
                              >
                                {dependency}
                              </Badge>
                            ))
                          : labels.none}
                      </dd>
                    </div>
                  </dl>
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

function DefinitionItem({
  label,
  value,
  monospace = false
}: {
  label: string;
  value: string;
  monospace?: boolean;
}): React.JSX.Element {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={
          monospace ? "break-all font-mono text-foreground" : "text-foreground"
        }
      >
        {value}
      </dd>
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
