import assert from "node:assert/strict";
import test from "node:test";
import type { ReporterEventInput } from "../../analytics/services/reporterService.interface.ts";
import { createDesktopIssueManagerAnalytics } from "./desktopIssueManagerAnalytics.ts";

test("desktop issue-manager analytics reports task run initiated events", async () => {
  const calls: ReporterEventInput[][] = [];
  const analytics = createDesktopIssueManagerAnalytics({
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        calls.push(events);
      }
    }
  });

  await analytics?.track({
    name: "issue_manager.task_run_initiated",
    params: {
      hasExecutionDirectory: false,
      issueId: "issue-1",
      provider: "codex",
      taskId: null
    }
  });

  assert.deepEqual(calls, [
    [
      {
        clientTS: 1749124800000,
        name: "issue_manager.task_run_initiated",
        params: {
          has_execution_directory: false,
          issue_id: "issue-1",
          provider: "codex",
          task_id: null
        }
      }
    ]
  ]);
});

test("desktop issue-manager analytics reports issue breakdown initiated events", async () => {
  const calls: ReporterEventInput[][] = [];
  const analytics = createDesktopIssueManagerAnalytics({
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        calls.push(events);
      }
    }
  });

  await analytics?.track({
    name: "issue_manager.issue_breakdown_initiated",
    params: {
      issueId: "issue-1",
      provider: "openclaw"
    }
  });

  assert.deepEqual(calls, [
    [
      {
        clientTS: 1749124800000,
        name: "issue_manager.issue_breakdown_initiated",
        params: {
          issue_id: "issue-1",
          provider: "openclaw"
        }
      }
    ]
  ]);
});

test("desktop issue-manager analytics reports context ref added events", async () => {
  const calls: ReporterEventInput[][] = [];
  const analytics = createDesktopIssueManagerAnalytics({
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        calls.push(events);
      }
    }
  });

  await analytics?.track({
    name: "issue_manager.context_ref_added",
    params: {
      refType: "file",
      targetType: "issue"
    }
  });

  assert.deepEqual(calls, [
    [
      {
        clientTS: 1749124800000,
        name: "issue_manager.context_ref_added",
        params: {
          ref_type: "file",
          target_type: "issue"
        }
      }
    ]
  ]);
});

test("desktop issue-manager analytics reports context ref removed events", async () => {
  const calls: ReporterEventInput[][] = [];
  const analytics = createDesktopIssueManagerAnalytics({
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        calls.push(events);
      }
    }
  });

  await analytics?.track({
    name: "issue_manager.context_ref_removed",
    params: {
      targetType: "task"
    }
  });

  assert.deepEqual(calls, [
    [
      {
        clientTS: 1749124800000,
        name: "issue_manager.context_ref_removed",
        params: {
          target_type: "task"
        }
      }
    ]
  ]);
});
