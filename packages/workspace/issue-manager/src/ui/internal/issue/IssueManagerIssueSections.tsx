import { type JSX } from "react";
import {
  AgentSessionsIcon,
  ArrowRightIcon,
  Badge,
  Button,
  FileCreateIcon,
  FileIcon,
  ScrollArea,
  cn
} from "@tutti-os/ui-system";
import type {
  IssueManagerFileReference,
  IssueManagerIssueSummary,
  IssueManagerRun,
  IssueManagerRunOutput,
  IssueManagerTaskSummary
} from "../../../contracts/index.ts";
import {
  formatIssueManagerTimestamp,
  resolveIssueManagerStatusLabel
} from "../../../services/controllerModel.ts";
import { IssueManagerTitleTooltip } from "../content/IssueManagerTitleTooltip.tsx";
import {
  stripIssueManagerDescriptionTerminalPunctuation,
  summarizeIssueManagerContent
} from "../panel/IssueManagerPanelText.ts";
import { IssueManagerTaskListLoadingState } from "../panel/IssueManagerPanelSurface.tsx";
import { issueManagerStatusBadgeVariant } from "../status/IssueManagerStatusBadge.ts";
import type { IssueManagerLatestRunStatusRenderer } from "../../latestRunStatusRenderer.ts";
import type { IssueManagerController } from "../../react/index.ts";
import type { IssueManagerI18nRuntime } from "../../../i18n/issueManagerI18n.ts";

export function IssueManagerDetailTextSection({
  body,
  isPlaceholder = false,
  label,
  meta,
  tone = "muted"
}: {
  body: string;
  isPlaceholder?: boolean;
  label: string;
  meta?: string;
  tone?: "destructive" | "muted";
}): JSX.Element {
  const bodyText = stripIssueManagerDescriptionTerminalPunctuation(body);
  const metaText = meta
    ? stripIssueManagerDescriptionTerminalPunctuation(meta)
    : null;
  const bodyClassName = cn(
    "max-w-full whitespace-normal break-words text-[13px] leading-5 [overflow-wrap:anywhere]",
    isPlaceholder
      ? "font-normal text-[var(--text-secondary)]"
      : tone === "destructive"
        ? "font-semibold text-[var(--state-danger)]"
        : "font-semibold text-[var(--text-primary)]"
  );

  if (isPlaceholder) {
    return (
      <section className="grid gap-2.5">
        <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
          {label}
        </h3>
        <p className={bodyClassName}>{bodyText}</p>
      </section>
    );
  }

  return (
    <section className="grid gap-2.5">
      <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
        {label}
      </h3>
      <div className="min-w-0 rounded-[12px] border border-[var(--line-2)] px-4 py-3">
        <p className={bodyClassName}>{bodyText}</p>
        {metaText ? (
          <p className="mt-1 truncate text-[11px] font-normal text-[var(--text-secondary)]">
            {metaText}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function IssueManagerLatestRunStatusSection({
  copy,
  latestRun,
  onOpenAgentSession,
  renderLatestRunStatus,
  title
}: {
  copy: IssueManagerI18nRuntime;
  latestRun: IssueManagerRun | null;
  onOpenAgentSession?: (run: IssueManagerRun) => Promise<void>;
  renderLatestRunStatus?: IssueManagerLatestRunStatusRenderer;
  title?: string | null;
}): JSX.Element {
  if (!latestRun) {
    return (
      <IssueManagerDetailTextSection
        body={copy.t("messages.noExecutionStatus")}
        isPlaceholder
        label={copy.t("labels.latestRunStatus")}
      />
    );
  }

  const agentSessionId = latestRun.agentSessionId?.trim() ?? "";
  const statusLabel = resolveIssueManagerStatusLabel(copy, latestRun.status);
  const summary = latestRun.summary?.trim() ?? "";
  const timestamp =
    formatIssueManagerTimestamp(
      latestRun.updatedAtUnix ??
        latestRun.completedAtUnix ??
        latestRun.startedAtUnix ??
        latestRun.createdAtUnix
    ) || "";
  const errorMessage = latestRun.errorMessage?.trim() ?? "";
  const canOpenAgentSession = Boolean(agentSessionId && onOpenAgentSession);
  const renderedLatestRunStatus =
    agentSessionId && renderLatestRunStatus
      ? renderLatestRunStatus({
          canOpenAgentSession,
          copy,
          latestRun,
          title: title?.trim() || "",
          onOpenAgentSession
        })
      : null;
  if (
    renderedLatestRunStatus !== null &&
    renderedLatestRunStatus !== undefined
  ) {
    return (
      <section className="grid gap-2.5">
        <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
          {copy.t("labels.latestRunStatus")}
        </h3>
        {renderedLatestRunStatus}
      </section>
    );
  }

  const primaryText =
    agentSessionId || summary || latestRun.runId || statusLabel;
  const content = (
    <div className="flex min-w-0 items-start gap-3">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--line-2)]",
          canOpenAgentSession
            ? "bg-transparency-actived text-primary"
            : "bg-transparent text-[var(--text-secondary)]"
        )}
      >
        <AgentSessionsIcon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p
            className={cn(
              "min-w-0 flex-1 text-[13px] font-semibold leading-5 text-[var(--text-primary)] [overflow-wrap:anywhere]",
              agentSessionId ? "font-mono" : ""
            )}
          >
            {primaryText}
          </p>
          <Badge variant={issueManagerStatusBadgeVariant(latestRun.status)}>
            {statusLabel}
          </Badge>
        </div>
        {summary && agentSessionId ? (
          <p className="mt-1 text-[11px] font-normal leading-5 text-[var(--text-secondary)] [overflow-wrap:anywhere]">
            {summary}
          </p>
        ) : null}
        {timestamp ? (
          <p className="mt-1 truncate text-[11px] font-normal text-[var(--text-secondary)]">
            {timestamp}
          </p>
        ) : null}
        {errorMessage ? (
          <p className="mt-2 text-[11px] font-medium leading-5 text-[var(--state-danger)] [overflow-wrap:anywhere]">
            {errorMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
  const cardClassName = cn(
    "min-w-0 rounded-[12px] border border-[var(--line-2)] px-4 py-3",
    canOpenAgentSession
      ? "w-full bg-transparent text-left transition-colors hover:bg-transparency-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:ring-inset"
      : "bg-transparent"
  );

  return (
    <section className="grid gap-2.5">
      <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
        {copy.t("labels.latestRunStatus")}
      </h3>
      {canOpenAgentSession ? (
        <button
          aria-label={copy.t("actions.openAgentSession")}
          className={cardClassName}
          title={copy.t("actions.openAgentSession")}
          type="button"
          onClick={() => {
            void onOpenAgentSession?.(latestRun);
          }}
        >
          {content}
        </button>
      ) : (
        <div className={cardClassName}>{content}</div>
      )}
    </section>
  );
}

export function IssueManagerOutputSection({
  copy,
  onOpen,
  outputs
}: {
  copy: IssueManagerI18nRuntime;
  onOpen: (reference: IssueManagerFileReference) => Promise<void>;
  outputs: readonly IssueManagerRunOutput[];
}): JSX.Element {
  return (
    <section className="grid gap-2.5">
      <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
        {copy.t("labels.executionOutputs")}
      </h3>
      {outputs.length === 0 ? (
        <p className="text-[13px] font-normal leading-6 text-[var(--text-secondary)]">
          {copy.t("messages.noExecutionOutputs")}
        </p>
      ) : (
        <div className="overflow-hidden rounded-[12px] border border-[var(--line-2)] bg-transparent">
          {outputs.map((output) => (
            <button
              aria-label={copy.t("actions.openReference")}
              className="flex w-full items-center justify-between gap-4 border-b border-[var(--line-2)] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-transparency-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:ring-inset"
              key={output.outputId}
              title={copy.t("actions.openReference")}
              type="button"
              onClick={() => {
                void onOpen({
                  displayName: output.displayName,
                  kind: "file",
                  path: output.path
                });
              }}
            >
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--line-2)] bg-transparency-actived text-primary"
                >
                  <FileIcon size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-[var(--text-primary)]">
                    {output.displayName}
                  </span>
                  <span className="mt-1 block truncate text-[11px] font-normal text-[var(--text-secondary)]">
                    {output.path}
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-[11px] font-normal text-[var(--text-secondary)]">
                  {formatIssueManagerTimestamp(output.createdAtUnix) || ""}
                </span>
                <span className="inline-flex h-7 items-center gap-1 rounded-md border border-primary/20 bg-transparency-actived px-2 text-[11px] font-semibold text-primary">
                  {copy.t("actions.openReference")}
                  <ArrowRightIcon size={13} />
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function IssueManagerSubtaskSection({
  copy,
  onCreate,
  onSelectTask,
  selectedTaskId,
  tasks
}: {
  copy: IssueManagerI18nRuntime;
  onCreate: () => void;
  onSelectTask: (taskId: string | null) => void;
  selectedTaskId: string | null;
  tasks: readonly IssueManagerTaskSummary[];
}): JSX.Element {
  return (
    <section className="grid gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
          {copy.t("labels.subtasks")}
        </h3>
        <Button size="dialog" type="button" variant="ghost" onClick={onCreate}>
          <FileCreateIcon size={14} />
          {copy.t("actions.add")}
        </Button>
      </div>
      {tasks.length === 0 ? (
        <p className="text-[13px] font-normal leading-6 text-[var(--text-secondary)]">
          {copy.t("messages.noSubtasksForIssue")}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--line-2)] bg-transparent">
          {tasks.map((task) => (
            <button
              className={cn(
                "flex w-full items-start justify-between gap-4 border-b border-[var(--line-2)] px-4 py-3 text-left transition-colors last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:ring-inset",
                selectedTaskId === task.taskId
                  ? "bg-transparency-actived"
                  : "bg-transparent hover:bg-transparency-hover"
              )}
              key={task.taskId}
              type="button"
              onClick={() => onSelectTask(task.taskId)}
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2.5">
                  <IssueManagerTitleTooltip title={task.title}>
                    <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
                      {task.title}
                    </span>
                  </IssueManagerTitleTooltip>
                  <Badge variant={issueManagerStatusBadgeVariant(task.status)}>
                    {resolveIssueManagerStatusLabel(copy, task.status)}
                  </Badge>
                </div>
                <p className="mt-2 line-clamp-2 text-[11px] font-normal leading-[1.5] text-[var(--text-secondary)]">
                  {summarizeIssueManagerContent(
                    task.content,
                    copy.t("messages.taskContentEmpty")
                  )}
                </p>
              </div>
              <span className="shrink-0 text-[11px] font-normal text-[var(--text-secondary)]">
                {formatIssueManagerTimestamp(
                  task.createdAtUnix ?? task.updatedAtUnix
                ) || ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function IssueManagerTaskSection({
  controller,
  selectedIssue,
  selectedTaskId
}: {
  controller: IssueManagerController;
  selectedIssue: IssueManagerIssueSummary | null;
  selectedTaskId: string | null;
}): JSX.Element {
  const copy = controller.copy;
  const tasks = controller.issueDetail.value?.tasks ?? [];

  return (
    <section className="border-t border-[var(--line-2)] bg-transparent">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--line-2)] px-8 py-4">
        <div>
          <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">
            {copy.t("labels.taskList")}
          </h3>
        </div>
        <Button
          className="px-3"
          disabled={!selectedIssue}
          size="dialog"
          type="button"
          variant="secondary"
          onClick={controller.createTaskDraft}
        >
          <FileCreateIcon size={14} />
          {copy.t("actions.createTask")}
        </Button>
      </div>

      <ScrollArea scrollbarMode="native" className="h-[16rem]">
        <div className="px-8 py-5">
          {controller.issueDetail.isLoading &&
          controller.issueDetail.value === null ? (
            <IssueManagerTaskListLoadingState />
          ) : tasks.length === 0 ? (
            <div className="overflow-hidden rounded-lg border border-[var(--line-2)] bg-transparent">
              <div className="px-4 py-10 text-center">
                <p className="text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
                  {copy.t("messages.noTasks")}
                </p>
                <p className="mt-2 text-[13px] font-normal leading-5 text-[var(--text-secondary)]">
                  {copy.t("messages.noTasksForIssueBody")}
                </p>
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-[var(--line-2)] bg-transparent">
              {tasks.map((task) => (
                <button
                  className={cn(
                    "block w-full border-b border-[var(--line-2)] px-3.5 py-3.5 text-left transition-colors last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:ring-inset",
                    selectedTaskId === task.taskId
                      ? "bg-transparency-actived"
                      : "bg-transparent hover:bg-transparency-hover"
                  )}
                  key={task.taskId}
                  type="button"
                  onClick={() => controller.selectTask(task.taskId)}
                >
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                        <IssueManagerTitleTooltip title={task.title}>
                          <span className="line-clamp-1 text-[13px] font-semibold leading-[1.3] text-[var(--text-primary)]">
                            {task.title}
                          </span>
                        </IssueManagerTitleTooltip>
                        <Badge
                          variant={issueManagerStatusBadgeVariant(task.status)}
                        >
                          {resolveIssueManagerStatusLabel(copy, task.status)}
                        </Badge>
                      </div>
                      <p className="text-[11px] font-normal leading-[18px] text-[var(--text-secondary)]">
                        {formatIssueManagerTimestamp(
                          task.createdAtUnix ?? task.updatedAtUnix
                        )}
                      </p>
                    </div>
                    <p className="line-clamp-2 text-[11px] font-normal leading-[1.5] text-[var(--text-secondary)]">
                      {summarizeIssueManagerContent(
                        task.content,
                        copy.t("messages.taskContentEmpty")
                      )}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
