import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIssueFromPlanRequest,
  prepareParallelIssueExecution
} from "./desktopAgentGUIPlanIssue.ts";

test("buildIssueFromPlanRequest preserves an Ultra Plan task graph and assignments", () => {
  const request = buildIssueFromPlanRequest({
    agentTargetId: "local:codex",
    agentSessionId: "session-1",
    fallbackTitle: "Approved plan",
    sourceDirectory: "/workspace/project",
    topicId: "default",
    planText: `# Ship model access

\`\`\`tutti-issue-plan-v1
{"title":"Ship model access","reasoningIntensity":70,"orchestrationIntensity":80,"budgetMode":"fixed","tokenBudget":120000,"quotaWaterlinePercent":15,"tasks":[{"id":"design","title":"Design","agentTargetId":"workspace-agent:architect","modelPlanId":"plan-1","model":"model-a","executionDirectory":"docs","dependencyTaskIds":[]},{"id":"build","title":"Build","executionDirectory":"src","dependencyTaskIds":["design"]}]}
\`\`\``
  });

  assert.equal(request.issue.planningSource, "ultra_plan");
  assert.deepEqual(request.issue.executionProfile, {
    reasoningIntensity: 70,
    orchestrationIntensity: 80
  });
  assert.equal(request.issue.budget?.mode, "fixed");
  assert.equal(request.issue.budget?.tokenLimit, 120000);
  assert.equal(request.tasks.length, 2);
  assert.equal(request.tasks[0]?.agentTargetId, "workspace-agent:architect");
  assert.equal(request.tasks[0]?.modelPlanId, "plan-1");
  assert.equal(request.tasks[0]?.executionDirectory, "/workspace/project/docs");
  assert.equal(request.tasks[1]?.agentTargetId, "local:codex");
  assert.deepEqual(request.tasks[1]?.dependencyTaskIds, [
    request.tasks[0]?.taskId
  ]);
});

test("buildIssueFromPlanRequest falls back to one assigned task for a traditional plan", () => {
  const request = buildIssueFromPlanRequest({
    agentTargetId: "local:claude-code",
    agentSessionId: "session-2",
    fallbackTitle: "Approved plan",
    topicId: "default",
    planText: "# Refactor renderer\n\nKeep business logic in tuttid."
  });

  assert.equal(request.issue.planningSource, "traditional_plan");
  assert.equal(request.issue.title, "Refactor renderer");
  assert.equal(request.tasks.length, 1);
  assert.equal(request.tasks[0]?.agentTargetId, "local:claude-code");
  assert.match(request.tasks[0]?.content ?? "", /business logic/u);
});

test("buildIssueFromPlanRequest rejects missing dependency references instead of launching them as roots", () => {
  assert.throws(
    () =>
      buildIssueFromPlanRequest({
        agentTargetId: "local:codex",
        agentSessionId: "session-3",
        fallbackTitle: "Approved plan",
        topicId: "default",
        planText: `\`\`\`tutti-issue-plan-v1
{"title":"Unsafe graph","tasks":[{"id":"build","title":"Build","dependencyTaskIds":["missing"]}]}
\`\`\``
      }),
    /issue_plan_dependency_task_not_found/u
  );
});

test("buildIssueFromPlanRequest rejects duplicate source task ids", () => {
  assert.throws(
    () =>
      buildIssueFromPlanRequest({
        agentTargetId: "local:codex",
        agentSessionId: "session-4",
        fallbackTitle: "Approved plan",
        topicId: "default",
        planText: `\`\`\`tutti-issue-plan-v1
{"title":"Ambiguous graph","tasks":[{"id":"same","title":"First"},{"id":"same","title":"Second"}]}
\`\`\``
      }),
    /issue_plan_duplicate_task_id/u
  );
});

test("buildIssueFromPlanRequest rejects execution directories outside the source workspace", () => {
  assert.throws(
    () =>
      buildIssueFromPlanRequest({
        agentTargetId: "local:codex",
        agentSessionId: "session-5",
        fallbackTitle: "Approved plan",
        sourceDirectory: "/workspace/project",
        topicId: "default",
        planText: `\`\`\`tutti-issue-plan-v1
{"title":"Escaping graph","tasks":[{"id":"build","title":"Build","executionDirectory":"../outside"}]}
\`\`\``
      }),
    /issue_plan_execution_directory_outside_workspace/u
  );
});

test("prepareParallelIssueExecution gives each assigned task an isolated Git worktree", async () => {
  const request = buildIssueFromPlanRequest({
    agentTargetId: "local:codex",
    agentSessionId: "session-parallel",
    fallbackTitle: "Approved plan",
    issueId: "issue-parallel",
    parallelExecution: true,
    sourceDirectory: "/workspace/project",
    topicId: "default",
    planText: `\`\`\`tutti-issue-plan-v1
{"title":"Parallel graph","tasks":[{"id":"one","title":"One"},{"id":"two","title":"Two"}]}
\`\`\``
  });
  const calls: unknown[] = [];

  const prepared = await prepareParallelIssueExecution({
    createGitWorktree: async (input) => {
      calls.push(input);
      return {
        branch: `tutti/${input.taskId}`,
        path: `/worktrees/${input.taskId}`
      };
    },
    request,
    sourceDirectory: "/workspace/project"
  });

  assert.equal(prepared.issue.parallelExecution, true);
  assert.equal(prepared.issue.sequentialExecution, false);
  assert.deepEqual(
    prepared.tasks.map((task) => task.executionDirectory),
    prepared.tasks.map((task) => `/worktrees/${task.taskId}`)
  );
  assert.deepEqual(
    calls,
    prepared.tasks.map((task) => ({
      issueId: "issue-parallel",
      sourceDirectory: "/workspace/project",
      taskId: task.taskId
    }))
  );
});

test("prepareParallelIssueExecution replaces model-suggested directories with owned worktrees", async () => {
  const request = buildIssueFromPlanRequest({
    agentTargetId: "local:codex",
    agentSessionId: "session-parallel",
    fallbackTitle: "Approved plan",
    issueId: "issue-parallel",
    parallelExecution: true,
    sourceDirectory: "/workspace/project",
    topicId: "default",
    planText: `\`\`\`tutti-issue-plan-v1
{"title":"Parallel graph","tasks":[{"id":"one","title":"One","executionDirectory":"packages/one"}]}
\`\`\``
  });

  const prepared = await prepareParallelIssueExecution({
    createGitWorktree: async (input) => ({
      branch: `tutti/${input.taskId}`,
      path: `/worktrees/${input.taskId}`
    }),
    request,
    sourceDirectory: "/workspace/project"
  });

  assert.equal(
    prepared.tasks[0]?.executionDirectory,
    `/worktrees/${prepared.tasks[0]?.taskId}`
  );
});

test("prepareParallelIssueExecution fails closed without an isolated worktree", async () => {
  const request = buildIssueFromPlanRequest({
    agentTargetId: "local:codex",
    agentSessionId: "session-parallel",
    fallbackTitle: "Approved plan",
    issueId: "issue-parallel",
    parallelExecution: true,
    sourceDirectory: "/workspace/plain",
    topicId: "default",
    planText: "# Parallel task"
  });

  await assert.rejects(
    prepareParallelIssueExecution({
      createGitWorktree: async () => null,
      request,
      sourceDirectory: "/workspace/plain"
    }),
    /agent_plan_parallel_worktree_unavailable/u
  );
});
