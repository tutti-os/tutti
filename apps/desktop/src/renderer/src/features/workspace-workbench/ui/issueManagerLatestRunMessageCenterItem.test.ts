import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceAgentMessageCenterItem } from "@tutti-os/agent-gui/agent-message-center";
import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import type { IssueManagerLatestRunStatusRenderInput } from "@tutti-os/workspace-issue-manager/ui";
import {
  resolveIssueManagerLatestRunMessageCenterItem,
  submitIssueManagerPendingInteraction,
  synchronizeIssueManagerLatestRunSession
} from "./issueManagerLatestRunMessageCenterItem.ts";

describe("resolveIssueManagerLatestRunMessageCenterItem", () => {
  it("prefers the engine model item so a hidden delegate keeps its pending prompt", () => {
    const modelItem = messageCenterItem({
      agentSessionId: "delegate-1",
      pendingInteractionTarget: {
        agentSessionId: "delegate-1",
        requestId: "request-approval",
        turnId: "turn-1"
      },
      pendingPrompt: {
        kind: "approval",
        id: "approval:request-approval",
        turnId: "turn-1",
        requestId: "request-approval",
        callId: "call-1",
        title: "Run command",
        toolName: "Bash",
        status: "pending",
        input: { command: "pnpm test" },
        options: [{ id: "allow", label: "Allow", kind: "allow" }],
        output: null,
        occurredAtUnixMs: 21
      },
      status: "waiting"
    });

    const item = resolveIssueManagerLatestRunMessageCenterItem({
      agentSessionId: "delegate-1",
      input: renderInput(),
      itemCandidates: [modelItem],
      session: null
    });

    assert.equal(item, modelItem);
    assert.equal(item.pendingPrompt?.kind, "approval");
    assert.equal(item.pendingInteractionTarget?.requestId, "request-approval");
  });

  it("synthesizes a promptless run fallback only when the engine has no item", () => {
    const item = resolveIssueManagerLatestRunMessageCenterItem({
      agentSessionId: "delegate-1",
      input: renderInput(),
      itemCandidates: [messageCenterItem({ agentSessionId: "other-session" })],
      session: null
    });

    assert.equal(item.id, "issue-manager-run-run-1");
    assert.equal(item.status, "working");
    assert.equal(item.pendingPrompt, null);
    assert.equal(item.pendingInteractionTarget, null);
    assert.equal(item.needsAttentionKind, null);
  });

  it("does not infer a model-item identity from a provider-native alias", () => {
    const item = resolveIssueManagerLatestRunMessageCenterItem({
      agentSessionId: "delegate-1",
      input: renderInput(),
      itemCandidates: [
        messageCenterItem({ agentSessionId: "provider-session-1" })
      ],
      session: normalizeAgentActivitySession({
        activeTurnId: null,
        agentSessionId: "delegate-1",
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        providerSessionId: "provider-session-1",
        title: "Delegate",
        workspaceId: "workspace-1"
      })
    });

    assert.equal(item.id, "issue-manager-run-run-1");
  });
});

describe("synchronizeIssueManagerLatestRunSession", () => {
  it("requests the exact hidden delegate while its Issue card is mounted", () => {
    const calls: unknown[] = [];
    const dispose = synchronizeIssueManagerLatestRunSession({
      agentSessionId: " delegate-1 ",
      service: {
        ensureSessionSynchronized(input) {
          calls.push(input);
          return () => calls.push("dispose");
        }
      },
      workspaceId: "workspace-1"
    });

    assert.deepEqual(calls, [
      {
        agentSessionId: "delegate-1",
        workspaceId: "workspace-1"
      }
    ]);
    dispose();
    assert.deepEqual(calls.at(-1), "dispose");
  });
});

describe("submitIssueManagerPendingInteraction", () => {
  it("answers the prompt's exact child session, turn, and request target", () => {
    const submissions: unknown[] = [];
    const accepted = submitIssueManagerPendingInteraction({
      engine: {
        submitInteractionResponse(input) {
          submissions.push(input);
          return true;
        }
      },
      item: messageCenterItem({
        agentSessionId: "delegate-root",
        pendingInteractionTarget: {
          agentSessionId: "delegate-child",
          requestId: "request-approval",
          turnId: "child-turn-1"
        }
      }),
      submitInput: {
        action: "approve",
        optionId: "allow",
        requestId: "request-approval"
      }
    });

    assert.equal(accepted, true);
    assert.deepEqual(submissions, [
      {
        action: "approve",
        agentSessionId: "delegate-child",
        optionId: "allow",
        requestId: "request-approval",
        turnId: "child-turn-1"
      }
    ]);
  });

  it("rejects a stale prompt request instead of guessing its identity", () => {
    const submissions: unknown[] = [];
    const accepted = submitIssueManagerPendingInteraction({
      engine: {
        submitInteractionResponse(input) {
          submissions.push(input);
          return true;
        }
      },
      item: messageCenterItem({
        pendingInteractionTarget: {
          agentSessionId: "delegate-1",
          requestId: "current-request",
          turnId: "turn-1"
        }
      }),
      submitInput: { requestId: "stale-request" }
    });

    assert.equal(accepted, false);
    assert.deepEqual(submissions, []);
  });
});

function renderInput(): IssueManagerLatestRunStatusRenderInput {
  return {
    canOpenAgentSession: true,
    copy: {} as IssueManagerLatestRunStatusRenderInput["copy"],
    latestRun: {
      runId: "run-1",
      issueId: "issue-1",
      workspaceId: "workspace-1",
      requesterUserId: "user-1",
      agentUserId: "agent-1",
      agentSessionId: "delegate-1",
      agentProvider: "codex",
      status: "running",
      updatedAtUnix: 1_700_000_000_000
    },
    title: "Delegated task"
  };
}

function messageCenterItem(
  overrides: Partial<WorkspaceAgentMessageCenterItem>
): WorkspaceAgentMessageCenterItem {
  return {
    agentSessionId: "session-1",
    cwd: "",
    id: "item-1",
    identity: null,
    lastAgentMessageAtUnixMs: null,
    lastAgentMessageSummary: "",
    digest: {
      primary: {
        kind: "summary",
        summary: "",
        occurredAtUnixMs: null
      }
    },
    needsAttentionKind: null,
    needsAttentionSummary: null,
    pendingInteractionTarget: null,
    pendingPrompt: null,
    provider: "codex",
    sortTimeUnixMs: 0,
    status: "idle",
    title: "",
    userId: null,
    ...overrides
  };
}
