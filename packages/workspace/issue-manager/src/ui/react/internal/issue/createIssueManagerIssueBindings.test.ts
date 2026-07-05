import assert from "node:assert/strict";
import test from "node:test";
import type {
  IssueManagerAnalyticsEvent,
  IssueManagerNodeState
} from "../../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../../core/index.ts";
import type {
  IssueDraft,
  IssueManagerControllerSession
} from "../../../../services/issueManagerControllerService.interface.ts";
import { createIssueManagerIssueBindings } from "./createIssueManagerIssueBindings.ts";

test("issue bindings seed the draft from node state when create mode opens", () => {
  const harness = createIssueHarness({
    issueDraftContent: "Saved description",
    issueDraftTitle: "Saved title"
  });

  harness.bindings.setIssueEditorMode("create");

  assert.equal(harness.issueEditorMode, "create");
  assert.deepEqual(harness.issueDraft, {
    content: "Saved description",
    title: "Saved title"
  });
});

test("issue bindings persist title changes through the session draft setter", () => {
  const harness = createIssueHarness();

  harness.bindings.setIssueTitle("Renamed issue");

  assert.equal(harness.issueDraft.title, "Renamed issue");
  assert.equal(harness.nodeState.issueDraftTitle, null);
});

test("issue bindings report context reference changes when content changes", () => {
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const harness = createIssueHarness(
    {},
    {
      analytics: {
        track(event: IssueManagerAnalyticsEvent) {
          analyticsEvents.push(event);
        }
      },
      initialIssueDraft: {
        content: "[old](/workspace/old.md)",
        title: ""
      },
      issueEditorMode: "edit"
    }
  );

  harness.bindings.setIssueContent(
    "[new](/workspace/new.md)\n\n[docs](/workspace/docs/)"
  );

  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.context_ref_added",
      params: { refType: "file", targetType: "issue" }
    },
    {
      name: "issue_manager.context_ref_added",
      params: { refType: "directory", targetType: "issue" }
    },
    {
      name: "issue_manager.context_ref_removed",
      params: { targetType: "issue" }
    }
  ]);
});

function createIssueHarness(
  nodeStatePatch?: Partial<IssueManagerNodeState>,
  options?: {
    analytics?: { track(event: IssueManagerAnalyticsEvent): void };
    initialIssueDraft?: IssueDraft;
    issueEditorMode?: "create" | "edit" | "read";
  }
) {
  let issueDraft: IssueDraft = {
    content: "",
    title: "",
    ...options?.initialIssueDraft
  };
  let issueEditorMode: "create" | "edit" | "read" =
    options?.issueEditorMode ?? "read";
  let nodeState: IssueManagerNodeState = {
    issueDraftContent: null,
    issueDraftTitle: null,
    issueSearchQuery: "",
    issueStatusFilter: "all",
    selectedAgentTargetId: "local:codex",
    selectedIssueId: null,
    selectedTaskId: null,
    taskDraftContent: null,
    taskDraftTitle: null,
    taskListCollapsed: false,
    ...nodeStatePatch
  };

  const session = {
    setIssueDraftInternal(update) {
      issueDraft = typeof update === "function" ? update(issueDraft) : update;
    },
    setIssueEditorModeState(update) {
      issueEditorMode =
        typeof update === "function" ? update(issueEditorMode) : update;
    },
    updateNodeState(update) {
      nodeState =
        typeof update === "function"
          ? update(nodeState)
          : { ...nodeState, ...update };
    }
  } as Pick<
    IssueManagerControllerSession,
    "setIssueDraftInternal" | "setIssueEditorModeState" | "updateNodeState"
  > as IssueManagerControllerSession;

  return {
    bindings: createIssueManagerIssueBindings({
      controllerSession: session,
      feature: {
        analytics: options?.analytics
      } as IssueManagerFeature,
      issueEditorMode,
      nodeState
    }),
    get issueDraft() {
      return issueDraft;
    },
    get issueEditorMode() {
      return issueEditorMode;
    },
    get nodeState() {
      return nodeState;
    }
  };
}
