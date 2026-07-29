import type {
  AgentActivityInteraction,
  AgentActivityNeedsAttentionItem,
  AgentActivityNeedsAttentionKind,
  AgentActivitySession,
  AgentActivitySnapshot
} from "./types.ts";
import type { AgentActivityDisplayStatus } from "./displayStatus.types.ts";

export function selectCanonicalAgentActivitySessions(
  snapshot: Pick<AgentActivitySnapshot, "sessions">
): readonly AgentActivitySession[] {
  return snapshot.sessions;
}

export function selectRootAgentActivitySessions(
  snapshot: Pick<AgentActivitySnapshot, "sessions">
): readonly AgentActivitySession[] {
  // In-memory optimistic root sessions may exist before their first daemon
  // snapshot is normalized. Only an explicit child relation excludes a
  // session from root conversation lists.
  return snapshot.sessions.filter((session) => session.kind !== "child");
}

export function selectNeedsAttentionCount(
  snapshot: AgentActivitySnapshot
): number {
  return selectNeedsAttentionItems(snapshot).length;
}

export function normalizeAgentActivityDisplayStatus(
  status: string | null | undefined,
  options: {
    activeTurnPhase?: string | null;
    latestTurnOutcome?: string | null;
    latestTurnPhase?: string | null;
    needsAttention?: boolean;
  } = {}
): AgentActivityDisplayStatus {
  const normalizedStatus = normalizeStatus(status);
  const normalizedTurnOutcome = normalizeStatus(options.latestTurnOutcome);
  switch (normalizeStatus(options.activeTurnPhase ?? options.latestTurnPhase)) {
    case "settled":
      switch (normalizedTurnOutcome) {
        case "failed":
        case "error":
          return "failed";
        case "canceled":
        case "cancelled":
        case "interrupted":
          return "canceled";
        case "completed":
        case "done":
        case "success":
        case "succeeded":
          return "completed";
        default:
          break;
      }
      if (normalizedStatus === "failed" || normalizedStatus === "error") {
        return "failed";
      }
      if (normalizedStatus === "canceled" || normalizedStatus === "cancelled") {
        return "canceled";
      }
      return "completed";
    case "waiting":
      return "waiting";
    case "running":
    case "submitted":
      return "working";
    default:
      break;
  }
  if (options.needsAttention) {
    return "waiting";
  }
  switch (normalizedStatus) {
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "error":
    case "failed":
      return "failed";
    default:
      break;
  }
  switch (normalizedStatus) {
    case "running":
    case "streaming":
    case "working":
      return "working";
    case "awaiting_approval":
    case "waiting":
    case "waiting_approval":
    case "waiting_input":
      return "waiting";
    case "idle":
    case "ready":
    default:
      return "idle";
  }
}

export function selectNeedsAttentionItems(
  snapshot: AgentActivitySnapshot
): AgentActivityNeedsAttentionItem[] {
  const items: AgentActivityNeedsAttentionItem[] = [];

  for (const session of snapshot.sessions) {
    for (const interaction of session.pendingInteractions) {
      if (interaction.status !== "pending") {
        continue;
      }
      items.push(
        needsAttentionItemFromInteraction(snapshot, session, interaction)
      );
    }
  }

  return items.sort(
    (left, right) =>
      right.occurredAtUnixMs - left.occurredAtUnixMs ||
      left.id.localeCompare(right.id)
  );
}

function needsAttentionItemFromInteraction(
  snapshot: AgentActivitySnapshot,
  session: AgentActivitySession,
  interaction: AgentActivityInteraction
): AgentActivityNeedsAttentionItem {
  return {
    id: `${session.agentSessionId}:${interaction.turnId}:${interaction.requestId}`,
    workspaceId: session.workspaceId || snapshot.workspaceId,
    agentSessionId: session.agentSessionId,
    provider: session.provider,
    title: session.title,
    cwd: session.cwd,
    kind: needsAttentionKindForInteraction(interaction),
    summary: interactionSummary(interaction),
    occurredAtUnixMs:
      interaction.updatedAtUnixMs ||
      interaction.createdAtUnixMs ||
      session.updatedAtUnixMs ||
      session.lastEventUnixMs ||
      0
  };
}

function needsAttentionKindForInteraction(
  interaction: AgentActivityInteraction
): AgentActivityNeedsAttentionKind {
  switch (interaction.kind) {
    case "approval":
      return "permission";
    case "question":
      return "question";
    case "plan":
      return "constraint";
  }
}

function interactionSummary(interaction: AgentActivityInteraction): string {
  const input = interaction.input ?? {};
  const metadata = interaction.metadata ?? {};
  return (
    stringValue(input.displayPrompt) ||
    stringValue(input.summary) ||
    stringValue(input.title) ||
    firstQuestionText(input.questions) ||
    stringValue(input.question) ||
    stringValue(input.prompt) ||
    stringValue(input.text) ||
    stringValue(metadata.summary) ||
    stringValue(metadata.title) ||
    interaction.toolName?.trim() ||
    interaction.kind
  );
}

function normalizeStatus(status: string | null | undefined): string {
  return status?.trim().toLowerCase() ?? "";
}

function firstQuestionText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  for (const candidate of value) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (candidate && typeof candidate === "object") {
      const question = stringValue(
        (candidate as Record<string, unknown>).question
      );
      if (question) {
        return question;
      }
    }
  }
  return "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
