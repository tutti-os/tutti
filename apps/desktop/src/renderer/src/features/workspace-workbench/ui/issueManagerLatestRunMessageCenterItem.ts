import type { WorkspaceAgentMessageCenterItem } from "@tutti-os/agent-gui/agent-message-center";
import type {
  AgentActivityMessage,
  AgentSessionEngine,
  CanonicalAgentSession
} from "@tutti-os/agent-activity-core";
import type { IssueManagerLatestRunStatusRenderInput } from "@tutti-os/workspace-issue-manager/ui";
import type { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent";

type MessageCenterAgentSession = CanonicalAgentSession;

export interface IssueManagerMessageCenterPromptSubmitInput {
  action?: string;
  optionId?: string;
  payload?: Record<string, unknown>;
  requestId: string;
}

/**
 * An Issue card is an explicit owner of its latest-run session. Ambient
 * session pages intentionally omit invisible delegates, so request the exact
 * canonical session (and its child state/messages) while this card is mounted.
 */
export function synchronizeIssueManagerLatestRunSession({
  agentSessionId,
  service,
  workspaceId
}: {
  agentSessionId: string;
  service: Pick<IWorkspaceAgentActivityService, "ensureSessionSynchronized">;
  workspaceId: string;
}): () => void {
  const normalizedAgentSessionId = agentSessionId.trim();
  if (!normalizedAgentSessionId) {
    return () => {};
  }
  return service.ensureSessionSynchronized({
    agentSessionId: normalizedAgentSessionId,
    workspaceId
  });
}

/**
 * The display item may represent a root conversation while its actionable
 * prompt belongs to a child session. Preserve the engine-owned exact target
 * tuple instead of reconstructing identity from the card subject.
 */
export function submitIssueManagerPendingInteraction({
  engine,
  item,
  submitInput
}: {
  engine: Pick<AgentSessionEngine, "submitInteractionResponse">;
  item: Pick<WorkspaceAgentMessageCenterItem, "pendingInteractionTarget">;
  submitInput: IssueManagerMessageCenterPromptSubmitInput;
}): boolean {
  const target = item.pendingInteractionTarget;
  if (!target || target.requestId !== submitInput.requestId) {
    return false;
  }
  return engine.submitInteractionResponse({
    agentSessionId: target.agentSessionId,
    requestId: target.requestId,
    turnId: target.turnId,
    ...(submitInput.action ? { action: submitInput.action } : {}),
    ...(submitInput.optionId ? { optionId: submitInput.optionId } : {}),
    ...(submitInput.payload ? { payload: submitInput.payload } : {})
  });
}

// Item resolution for the Issue task card. The delegate session may be
// invisible (Tutti Mode hides mass-dispatched runs from the conversation
// rail), so the card builds its model with the delegate allowlisted via
// includeHiddenSessionIds; when the engine has the session, the model item —
// including pending prompts — must win over the synthesized run fallback.
export function resolveIssueManagerLatestRunMessageCenterItem({
  agentSessionId,
  input,
  itemCandidates,
  session
}: {
  agentSessionId: string;
  input: IssueManagerLatestRunStatusRenderInput;
  itemCandidates: readonly WorkspaceAgentMessageCenterItem[];
  session: MessageCenterAgentSession | null;
}): WorkspaceAgentMessageCenterItem {
  return (
    findWorkspaceAgentMessageCenterItem({
      agentSessionId,
      itemCandidates,
      session
    }) ??
    createIssueManagerFallbackMessageCenterItem({
      agentSessionId,
      input
    })
  );
}

export function findWorkspaceAgentMessageCenterItem({
  agentSessionId,
  itemCandidates,
  session
}: {
  agentSessionId: string;
  itemCandidates: readonly WorkspaceAgentMessageCenterItem[];
  session: MessageCenterAgentSession | null;
}): WorkspaceAgentMessageCenterItem | null {
  const canonicalSessionIds = new Set([
    agentSessionId.trim(),
    session?.agentSessionId.trim() ?? ""
  ]);
  canonicalSessionIds.delete("");
  return (
    itemCandidates.find((item) =>
      canonicalSessionIds.has(item.agentSessionId.trim())
    ) ?? null
  );
}

export function createIssueManagerFallbackMessageCenterItem({
  agentSessionId,
  input
}: {
  agentSessionId: string;
  input: IssueManagerLatestRunStatusRenderInput;
}): WorkspaceAgentMessageCenterItem {
  const latestRun = input.latestRun;
  const provider = latestRun.agentProvider?.trim() || "codex";
  const summary =
    latestRun.status === "failed"
      ? latestRun.errorMessage?.trim() || latestRun.summary?.trim() || ""
      : latestRun.summary?.trim() || "";
  const sortTimeUnixMs = issueManagerRunTimestampToUnixMs(
    latestRun.updatedAtUnix ??
      latestRun.completedAtUnix ??
      latestRun.startedAtUnix ??
      latestRun.createdAtUnix
  );
  const status = issueManagerRunStatusToMessageCenterStatus(latestRun.status);
  const digestSummary = summary || input.title || agentSessionId;

  return {
    agentSessionId,
    cwd: "",
    id: `issue-manager-run-${latestRun.runId}`,
    identity: null,
    lastAgentMessageAtUnixMs: sortTimeUnixMs || null,
    lastAgentMessageSummary: summary,
    digest: {
      primary: {
        kind: issueManagerRunStatusToDigestKind(status),
        summary: digestSummary,
        occurredAtUnixMs: sortTimeUnixMs || null
      }
    },
    needsAttentionKind: null,
    needsAttentionSummary: null,
    pendingInteractionTarget: null,
    pendingPrompt: null,
    provider,
    sortTimeUnixMs,
    status,
    title: input.title || agentSessionId,
    userId: null
  };
}

function issueManagerRunStatusToMessageCenterStatus(
  status: string
): WorkspaceAgentMessageCenterItem["status"] {
  switch (status) {
    case "running":
      return "working";
    case "pending_acceptance":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "idle";
  }
}

function issueManagerRunStatusToDigestKind(
  status: WorkspaceAgentMessageCenterItem["status"]
): WorkspaceAgentMessageCenterItem["digest"]["primary"]["kind"] {
  switch (status) {
    case "failed":
      return "error";
    case "completed":
    case "canceled":
    case "idle":
      return "outcome";
    case "working":
      return "progress";
    default:
      return "summary";
  }
}

function issueManagerRunTimestampToUnixMs(
  value: number | null | undefined
): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const timestamp = Number(value);
  return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
}

export function hasCachedWorkspaceAgentSessionMessages(
  sessionMessagesById: Readonly<
    Record<string, readonly AgentActivityMessage[]>
  >,
  session: MessageCenterAgentSession
): boolean {
  return workspaceAgentSessionMessageAliases(session).some(
    (alias) => (sessionMessagesById[alias]?.length ?? 0) > 0
  );
}

export function workspaceAgentSessionMessageAliases(
  session: MessageCenterAgentSession
): string[] {
  return [
    session.agentSessionId,
    session.providerSessionId ?? "",
    session.agentSessionId.trim(),
    (session.providerSessionId ?? "").trim()
  ].filter((alias, index, aliases) => {
    const normalized = alias.trim();
    return normalized.length > 0 && aliases.indexOf(alias) === index;
  });
}
