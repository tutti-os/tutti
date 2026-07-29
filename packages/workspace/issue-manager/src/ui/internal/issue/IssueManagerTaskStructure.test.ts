import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueManagerTaskSummary } from "../../../contracts/index.ts";
import {
  groupIssueManagerTasksIntoStages,
  issueManagerTasksHaveParallelStructure
} from "./IssueManagerTaskStructure.tsx";

function task(
  overrides: Partial<IssueManagerTaskSummary> & { taskId: string }
): IssueManagerTaskSummary {
  return {
    issueId: "issue-1",
    workspaceId: "workspace-1",
    title: overrides.taskId,
    status: "not_started",
    priority: "medium",
    creatorUserId: "user-1",
    ...overrides
  };
}

test("groups consecutive parallelizable tasks into one stage and isolates exclusive tasks", () => {
  const stages = groupIssueManagerTasksIntoStages([
    task({ taskId: "p1", sortIndex: 1, parallelizable: true }),
    task({ taskId: "p2", sortIndex: 2, parallelizable: true }),
    task({ taskId: "s3", sortIndex: 3 }),
    task({ taskId: "p4", sortIndex: 4, parallelizable: true })
  ]);
  assert.deepEqual(
    stages.map((stage) => ({
      kind: stage.kind,
      ids: stage.tasks.map((item) => item.taskId)
    })),
    [
      { kind: "parallel", ids: ["p1", "p2"] },
      { kind: "sequential", ids: ["s3"] },
      { kind: "parallel", ids: ["p4"] }
    ]
  );
});

test("orders stages by sort index regardless of input order", () => {
  const stages = groupIssueManagerTasksIntoStages([
    task({ taskId: "s2", sortIndex: 2 }),
    task({ taskId: "p1", sortIndex: 1, parallelizable: true })
  ]);
  assert.deepEqual(
    stages.map((stage) => stage.tasks.map((item) => item.taskId)),
    [["p1"], ["s2"]]
  );
});

test("parallel structure detection requires an explicit opt-in", () => {
  assert.equal(
    issueManagerTasksHaveParallelStructure([task({ taskId: "s1" })]),
    false
  );
  assert.equal(
    issueManagerTasksHaveParallelStructure([
      task({ taskId: "p1", parallelizable: true })
    ]),
    true
  );
});
