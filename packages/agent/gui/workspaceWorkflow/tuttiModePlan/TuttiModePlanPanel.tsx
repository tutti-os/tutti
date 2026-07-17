import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn
} from "@tutti-os/ui-system";
import composerStyles from "../../agent-gui/agentGuiNode/AgentGUINode.styles";
import type {
  TuttiModePlanPanelTaskViewModel,
  TuttiModePlanPanelViewModel
} from "./tuttiModePlanPanelProjection";
import type { TuttiModePlanAssignmentCatalog } from "./useTuttiModePlanPanels";
import {
  TuttiModePlanTaskAssignmentEditor,
  permissionModeAssignmentTone
} from "./TuttiModePlanTaskAssignmentEditor";
import type {
  TuttiModePlanTaskAssignmentDraft,
  TuttiModePlanTaskAssignmentDrafts
} from "./tuttiModePlanTaskAssignments";

export interface TuttiModePlanPanelLabels {
  mode: string;
  taskReview: string;
  pending: string;
  tasks: string;
  priority: string;
  priorityHigh: string;
  priorityMedium: string;
  priorityLow: string;
  agentTarget: string;
  model: string;
  permissionMode: string;
  reasoningEffort: string;
  parallelizable: string;
  autoAccept: string;
  notSpecified: string;
  assignmentOptionsLoading: string;
}

/**
 * Read-only review card for a pending Tutti mode plan. Decisions live in the
 * composer (empty send accepts, typed feedback rejects, the review banner
 * cancels), so the card carries no action buttons of its own; the only
 * interactive piece is the per-task assignment row, whose drafts the host
 * owns so an accept from the composer can include them.
 */
export function TuttiModePlanPanel({
  assignmentCatalog,
  assignmentDrafts,
  labels,
  panel,
  submitting,
  onAssignmentDraftChange
}: {
  assignmentCatalog?: TuttiModePlanAssignmentCatalog | null;
  assignmentDrafts?: TuttiModePlanTaskAssignmentDrafts;
  labels: TuttiModePlanPanelLabels;
  panel: TuttiModePlanPanelViewModel;
  submitting: boolean;
  onAssignmentDraftChange?(
    taskId: string,
    patch: TuttiModePlanTaskAssignmentDraft
  ): void;
}): React.JSX.Element {
  // Editing needs the loaded agent directory plus a host-owned draft store;
  // before that (or without a host catalog at all) tasks stay read-only.
  const editable =
    assignmentCatalog?.agents != null &&
    panel.actionable &&
    onAssignmentDraftChange !== undefined;

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
                      draft={assignmentDrafts?.[task.id] ?? {}}
                      labels={labels}
                      task={task}
                      onEdit={(patch) =>
                        onAssignmentDraftChange?.(task.id, patch)
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
      </CardContent>
    </Card>
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
    { label: labels.model, value: task.model },
    {
      label: labels.permissionMode,
      tone: permissionModeAssignmentTone(task.permissionModeId),
      value: task.permissionModeId
    },
    { label: labels.reasoningEffort, value: task.reasoningEffort },
    {
      label: labels.parallelizable,
      tone: "accent" as const,
      value: task.parallelizable ? labels.parallelizable : null
    },
    {
      label: labels.autoAccept,
      tone: "success" as const,
      value: task.autoAccept ? labels.autoAccept : null
    }
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
