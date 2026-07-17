import { useState } from "react";
import { ExternalLink, ListChecks } from "lucide-react";
import { Button, Card, CardContent, CardHeader, cn } from "@tutti-os/ui-system";
import composerStyles from "../../agent-gui/agentGuiNode/AgentGUINode.styles";
import type {
  TuttiPlanIssueSnapshot,
  TuttiPlanIssueTaskSnapshot
} from "../workspaceWorkflowRuntime";

export interface TuttiPlanIssuePanelLabels {
  openIssue: string;
  listView: string;
  boardView: string;
  parallelizable: string;
  autoAccept: string;
  accept: string;
  rework: string;
  dependencies: string;
  stageParallel: (index: string, count: string) => string;
  stageSequential: (index: string) => string;
  summary: (done: string, total: string, running: string) => string;
  statusNotStarted: string;
  statusRunning: string;
  statusPendingAcceptance: string;
  statusCompleted: string;
  statusFailed: string;
  statusCanceled: string;
}

type TuttiPlanIssueViewMode = "list" | "board";

const BOARD_STATUS_ORDER = [
  "not_started",
  "running",
  "pending_acceptance",
  "completed",
  "failed",
  "canceled"
] as const;

type BoardStatus = (typeof BOARD_STATUS_ORDER)[number];

function boardStatusOf(task: TuttiPlanIssueTaskSnapshot): BoardStatus {
  return (BOARD_STATUS_ORDER as readonly string[]).includes(task.status)
    ? (task.status as BoardStatus)
    : "not_started";
}

function statusLabel(
  labels: TuttiPlanIssuePanelLabels,
  status: BoardStatus
): string {
  switch (status) {
    case "running":
      return labels.statusRunning;
    case "pending_acceptance":
      return labels.statusPendingAcceptance;
    case "completed":
      return labels.statusCompleted;
    case "failed":
      return labels.statusFailed;
    case "canceled":
      return labels.statusCanceled;
    default:
      return labels.statusNotStarted;
  }
}

function statusDotClassName(status: BoardStatus): string {
  switch (status) {
    case "running":
      return "bg-[var(--status-running)]";
    case "pending_acceptance":
      return "bg-[var(--tutti-purple)]";
    case "completed":
      return "bg-[var(--state-success)]";
    case "failed":
      return "bg-[var(--state-danger)]";
    case "canceled":
      return "bg-[var(--text-tertiary)]";
    default:
      return "bg-[var(--text-secondary)]";
  }
}

type TuttiPlanIssueStage = {
  kind: "parallel" | "sequential";
  tasks: TuttiPlanIssueTaskSnapshot[];
};

/** Mirrors the dispatcher grouping: consecutive parallelizable tasks share a
 * stage; every exclusive task stands alone. */
export function groupTuttiPlanIssueTasksIntoStages(
  tasks: readonly TuttiPlanIssueTaskSnapshot[]
): TuttiPlanIssueStage[] {
  const ordered = [...tasks].sort(
    (left, right) => left.sortIndex - right.sortIndex
  );
  const stages: TuttiPlanIssueStage[] = [];
  for (const task of ordered) {
    const previous = stages.at(-1);
    if (task.parallelizable && previous?.kind === "parallel") {
      previous.tasks.push(task);
      continue;
    }
    stages.push({
      kind: task.parallelizable ? "parallel" : "sequential",
      tasks: [task]
    });
  }
  return stages;
}

/** The acceptance decision the embedded panel can settle on one task. */
export type TuttiPlanIssueTaskDecision = "accept" | "rework";

/**
 * Embedded "issue panel view" for the source conversation: once the accepted
 * plan materialized an Issue, the conversation shows its subtasks as a live
 * board/list. The acceptance gate closes here too — pending tasks offer
 * accept/rework inline — while all other mutations stay in the Issue Manager;
 * a jump into the full Issue surface remains one click away.
 */
export function TuttiPlanIssuePanel({
  issue,
  labels,
  onOpenIssue,
  onDecideTask
}: {
  issue: TuttiPlanIssueSnapshot;
  labels: TuttiPlanIssuePanelLabels;
  onOpenIssue?: () => void;
  onDecideTask?: (
    taskId: string,
    decision: TuttiPlanIssueTaskDecision
  ) => Promise<void>;
}): React.JSX.Element {
  const [viewMode, setViewMode] = useState<TuttiPlanIssueViewMode>("board");
  const [decidingTaskIds, setDecidingTaskIds] = useState<readonly string[]>([]);
  const decideTask = onDecideTask
    ? (taskId: string, decision: TuttiPlanIssueTaskDecision): void => {
        setDecidingTaskIds((current) =>
          current.includes(taskId) ? current : [...current, taskId]
        );
        void onDecideTask(taskId, decision)
          .catch(() => {
            // Best-effort mutation; the live issue stream re-syncs status and
            // the buttons return for a retry.
          })
          .finally(() => {
            setDecidingTaskIds((current) =>
              current.filter((id) => id !== taskId)
            );
          });
      }
    : undefined;
  const done = issue.tasks.filter((task) => task.status === "completed").length;
  const running = issue.tasks.filter(
    (task) => task.status === "running"
  ).length;
  return (
    <Card
      className="mx-auto w-full max-w-[860px]"
      data-testid="tutti-plan-issue-panel"
    >
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <ListChecks
              aria-hidden
              className="size-4 shrink-0 text-[var(--tutti-purple)]"
            />
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {issue.title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {labels.summary(
                String(done),
                String(issue.tasks.length),
                String(running)
              )}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <div className="flex items-center gap-0.5">
              {(["list", "board"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={viewMode === mode}
                  className={cn(
                    "w-auto",
                    composerStyles.composerMenuTrigger,
                    viewMode === mode &&
                      "text-[var(--tutti-purple)] hover:text-[var(--tutti-purple)]"
                  )}
                  data-testid={`tutti-plan-issue-view-${mode}`}
                  onClick={() => setViewMode(mode)}
                >
                  {mode === "list" ? labels.listView : labels.boardView}
                </button>
              ))}
            </div>
            {onOpenIssue ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-testid="tutti-plan-issue-open"
                onClick={onOpenIssue}
              >
                <ExternalLink aria-hidden className="size-3.5" />
                {labels.openIssue}
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {viewMode === "board" ? (
          <TuttiPlanIssueBoard
            issue={issue}
            labels={labels}
            decideTask={decideTask}
            decidingTaskIds={decidingTaskIds}
          />
        ) : (
          <TuttiPlanIssueList
            issue={issue}
            labels={labels}
            decideTask={decideTask}
            decidingTaskIds={decidingTaskIds}
          />
        )}
      </CardContent>
    </Card>
  );
}

function TaskStructureChips({
  labels,
  task
}: {
  labels: TuttiPlanIssuePanelLabels;
  task: TuttiPlanIssueTaskSnapshot;
}): React.JSX.Element | null {
  const dependencies = task.dependencyTaskIds.filter((id) => id.trim() !== "");
  if (!task.parallelizable && !task.autoAccept && dependencies.length === 0) {
    return null;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {task.parallelizable ? (
        <span className="shrink-0 rounded-full border border-[color-mix(in_srgb,var(--tutti-purple)_36%,transparent)] px-1.5 text-[10px] leading-4 text-[var(--tutti-purple)]">
          {labels.parallelizable}
        </span>
      ) : null}
      {task.autoAccept ? (
        <span className="shrink-0 rounded-full border border-[color-mix(in_srgb,var(--state-success)_42%,transparent)] px-1.5 text-[10px] leading-4 text-[var(--state-success)]">
          {labels.autoAccept}
        </span>
      ) : null}
      {dependencies.length > 0 ? (
        <span
          className="min-w-0 truncate rounded-full border border-border/70 px-1.5 text-[10px] leading-4 text-muted-foreground"
          title={dependencies.join(", ")}
        >
          {labels.dependencies}: {dependencies.join(", ")}
        </span>
      ) : null}
    </span>
  );
}

function TaskDecisionActions({
  labels,
  task,
  decideTask,
  deciding
}: {
  labels: TuttiPlanIssuePanelLabels;
  task: TuttiPlanIssueTaskSnapshot;
  decideTask?: (taskId: string, decision: TuttiPlanIssueTaskDecision) => void;
  deciding: boolean;
}): React.JSX.Element | null {
  if (!decideTask || task.status !== "pending_acceptance") {
    return null;
  }
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="sm"
        className="h-6 bg-[var(--tutti-purple)] px-2 text-[11px] text-white hover:bg-[color-mix(in_srgb,var(--tutti-purple)_85%,black)]"
        disabled={deciding}
        data-testid={`tutti-plan-issue-accept-${task.taskId}`}
        onClick={() => decideTask(task.taskId, "accept")}
      >
        {labels.accept}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-6 px-2 text-[11px]"
        disabled={deciding}
        data-testid={`tutti-plan-issue-rework-${task.taskId}`}
        onClick={() => decideTask(task.taskId, "rework")}
      >
        {labels.rework}
      </Button>
    </span>
  );
}

function TuttiPlanIssueBoard({
  issue,
  labels,
  decideTask,
  decidingTaskIds
}: {
  issue: TuttiPlanIssueSnapshot;
  labels: TuttiPlanIssuePanelLabels;
  decideTask?: (taskId: string, decision: TuttiPlanIssueTaskDecision) => void;
  decidingTaskIds: readonly string[];
}): React.JSX.Element {
  const groups = new Map<BoardStatus, TuttiPlanIssueTaskSnapshot[]>();
  for (const task of issue.tasks) {
    const status = boardStatusOf(task);
    groups.set(status, [...(groups.get(status) ?? []), task]);
  }
  const columns = BOARD_STATUS_ORDER.filter((status) =>
    status === "failed" || status === "canceled"
      ? (groups.get(status)?.length ?? 0) > 0
      : true
  );
  return (
    <div className="min-w-0 overflow-x-auto pb-1 [scrollbar-width:thin]">
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${columns.length}, minmax(170px, 1fr))`
        }}
      >
        {columns.map((status) => {
          const tasks = groups.get(status) ?? [];
          return (
            <div
              key={status}
              className="min-h-[120px] rounded-lg border border-border/70 bg-muted/30 px-2 py-2"
              data-testid={`tutti-plan-issue-column-${status}`}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      statusDotClassName(status)
                    )}
                  />
                  <span className="truncate text-[11px] font-medium text-foreground">
                    {statusLabel(labels, status)}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {tasks.length}
                </span>
              </div>
              <div className="grid gap-1.5">
                {tasks.map((task) => (
                  <div
                    key={task.taskId}
                    className="rounded-md bg-background px-2 py-1.5"
                  >
                    <span className="line-clamp-2 text-xs font-medium text-foreground">
                      {task.title}
                    </span>
                    <span className="mt-1 block empty:hidden">
                      <TaskStructureChips labels={labels} task={task} />
                    </span>
                    <span className="mt-1.5 block empty:hidden">
                      <TaskDecisionActions
                        labels={labels}
                        task={task}
                        decideTask={decideTask}
                        deciding={decidingTaskIds.includes(task.taskId)}
                      />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TuttiPlanIssueList({
  issue,
  labels,
  decideTask,
  decidingTaskIds
}: {
  issue: TuttiPlanIssueSnapshot;
  labels: TuttiPlanIssuePanelLabels;
  decideTask?: (taskId: string, decision: TuttiPlanIssueTaskDecision) => void;
  decidingTaskIds: readonly string[];
}): React.JSX.Element {
  const showStages = issue.tasks.some((task) => task.parallelizable);
  const stages = showStages
    ? groupTuttiPlanIssueTasksIntoStages(issue.tasks)
    : [{ kind: "sequential" as const, tasks: [...issue.tasks] }];
  return (
    <div className="overflow-hidden rounded-lg border border-border/70">
      {stages.map((stage, index) => (
        <div key={`stage-${index}`}>
          {showStages ? (
            <div
              className="border-b border-border/70 bg-muted/40 px-3 py-1 text-[10px] font-medium text-muted-foreground"
              data-testid={`tutti-plan-issue-stage-${stage.kind}`}
            >
              {stage.kind === "parallel"
                ? labels.stageParallel(
                    String(index + 1),
                    String(stage.tasks.length)
                  )
                : labels.stageSequential(String(index + 1))}
            </div>
          ) : null}
          {stage.tasks.map((task) => {
            const status = boardStatusOf(task);
            return (
              <div
                key={task.taskId}
                className="flex items-start justify-between gap-3 border-b border-border/70 px-3 py-2 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-foreground">
                      {task.title}
                    </span>
                    <TaskStructureChips labels={labels} task={task} />
                  </div>
                  {task.content ? (
                    <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                      {task.content}
                    </p>
                  ) : null}
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  <TaskDecisionActions
                    labels={labels}
                    task={task}
                    decideTask={decideTask}
                    deciding={decidingTaskIds.includes(task.taskId)}
                  />
                  <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 rounded-full",
                        statusDotClassName(status)
                      )}
                    />
                    {statusLabel(labels, status)}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
