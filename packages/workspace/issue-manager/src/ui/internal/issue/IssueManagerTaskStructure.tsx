import type { JSX } from "react";
import { cn } from "@tutti-os/ui-system";
import type { IssueManagerTaskSummary } from "../../../contracts/index.ts";
import type { IssueManagerI18nRuntime } from "../../../i18n/issueManagerI18n.ts";

export type IssueManagerTaskStage = {
  kind: "parallel" | "sequential";
  tasks: IssueManagerTaskSummary[];
};

/**
 * Groups tasks into display stages mirroring the dispatcher semantics on a
 * sequential Issue: consecutive parallelizable tasks form one parallel stage
 * (they may run alongside each other), every exclusive task is its own
 * sequential stage (it runs alone). Stage grouping is only meaningful when at
 * least one task opted into parallelism — callers should skip headers
 * otherwise.
 */
export function groupIssueManagerTasksIntoStages(
  tasks: readonly IssueManagerTaskSummary[]
): IssueManagerTaskStage[] {
  const ordered = [...tasks].sort(
    (left, right) => (left.sortIndex ?? 0) - (right.sortIndex ?? 0)
  );
  const stages: IssueManagerTaskStage[] = [];
  for (const task of ordered) {
    const previous = stages.at(-1);
    if (task.parallelizable === true) {
      if (previous?.kind === "parallel") {
        previous.tasks.push(task);
        continue;
      }
      stages.push({ kind: "parallel", tasks: [task] });
      continue;
    }
    stages.push({ kind: "sequential", tasks: [task] });
  }
  return stages;
}

export function issueManagerTasksHaveParallelStructure(
  tasks: readonly IssueManagerTaskSummary[]
): boolean {
  return tasks.some((task) => task.parallelizable === true);
}

/**
 * Compact execution-structure chips for one task: the parallel opt-in and its
 * explicit dependencies. Renders nothing for a plain sequential task.
 */
export function IssueManagerTaskStructureChips({
  copy,
  task
}: {
  copy: IssueManagerI18nRuntime;
  task: IssueManagerTaskSummary;
}): JSX.Element | null {
  const dependencyIds = (task.dependencyTaskIds ?? []).filter(
    (id) => id.trim() !== ""
  );
  if (task.parallelizable !== true && dependencyIds.length === 0) {
    return null;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {task.parallelizable === true ? (
        <span
          className={cn(
            "shrink-0 rounded-full border px-1.5 text-[10px] leading-4",
            "border-[color-mix(in_srgb,var(--tutti-purple)_36%,transparent)] text-[var(--tutti-purple)]"
          )}
          data-issue-manager-task-parallel-chip
        >
          {copy.t("labels.parallelizable")}
        </span>
      ) : null}
      {dependencyIds.length > 0 ? (
        <span
          className="min-w-0 truncate rounded-full border border-[var(--line-2)] px-1.5 text-[10px] leading-4 text-[var(--text-tertiary)]"
          data-issue-manager-task-dependency-chip
          title={dependencyIds.join(", ")}
        >
          {copy.t("labels.dependencies")}: {dependencyIds.join(", ")}
        </span>
      ) : null}
    </span>
  );
}
