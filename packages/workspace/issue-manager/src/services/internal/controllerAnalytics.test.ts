import assert from "node:assert/strict";
import test from "node:test";
import type { ReporterEventInput } from "@tutti-os/analytics";
import type { IssueManagerFeature } from "../../core/index.ts";
import { trackIssueManagerAnalytics } from "./controllerAnalytics.ts";

test("trackIssueManagerAnalytics reports package events through IReporterService", async () => {
  const events: ReporterEventInput[] = [];
  const feature = {
    reporterService: {
      async trackEvents(input) {
        events.push(...input);
      }
    }
  } as IssueManagerFeature;

  trackIssueManagerAnalytics(feature, {
    name: "issue_manager.issue_saved",
    params: {
      contextRefCount: 2,
      hasDescription: true,
      issueId: "issue-1",
      taskCount: 3
    }
  });
  await Promise.resolve();

  assert.deepEqual(events, [
    {
      name: "issue_manager.issue_saved",
      params: {
        context_ref_count: 2,
        has_description: true,
        issue_id: "issue-1",
        task_count: 3
      }
    }
  ]);
});

test("trackIssueManagerAnalytics keeps the legacy adapter as a fallback", async () => {
  const tracked: string[] = [];
  const feature = {
    analytics: {
      track(event) {
        tracked.push(event.name);
      }
    }
  } as IssueManagerFeature;

  trackIssueManagerAnalytics(feature, {
    name: "issue_manager.issue_created",
    params: { issueId: "issue-1" }
  });
  await Promise.resolve();

  assert.deepEqual(tracked, ["issue_manager.issue_created"]);
});
