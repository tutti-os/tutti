import type {
  AgentActivityInteraction,
  AgentActivityMessage,
  AgentActivityNeedsAttentionItem,
  AgentActivitySnapshot,
  AgentSessionEngineState,
  WorkspaceAgentConsumerSession
} from "@tutti-os/agent-activity-core";
import {
  selectEngineInteractionResponse,
  selectPendingSubmitsForSession,
  selectPlanDecisionForTurn
} from "@tutti-os/agent-activity-core";
import type { AgentConversationPromptVM } from "../shared/agentConversation/contracts/agentConversationVM";
import { normalizeAskUserQuestions } from "../shared/agentConversation/askUserQuestions";
import {
  buildWorkspaceAgentMessageCenterItem,
  buildWorkspaceAgentMessageCenterModelFromItems,
  type BuildWorkspaceAgentMessageCenterOptions,
  type WorkspaceAgentMessageCenterModel,
  type WorkspaceAgentMessageCenterTurnOutcome
} from "./workspaceAgentMessageCenterModel";
import { selectWorkspaceAgentConsumerSessions } from "./workspaceAgentConsumerSelectors";

/**
 * Canonical Message Center entrypoint. Session/turn/interaction truth comes
 * directly from the engine. Durable messages are presentation input only:
 * title and digest text may use them, but they cannot recreate lifecycle or
 * pending-interaction state.
 */
export function buildWorkspaceAgentMessageCenterModelFromEngine(
  presentation: WorkspaceAgentMessageCenterPresentation,
  snapshot: Pick<AgentActivitySnapshot, "sessionMessagesById" | "workspaceId">,
  options: BuildWorkspaceAgentMessageCenterOptions = {}
): WorkspaceAgentMessageCenterModel {
  const items = presentation.consumers
    .filter((consumer) => consumer.session.visible !== false)
    .map((consumer) => {
      const interaction = latestPendingInteraction(consumer);
      const needsAttention = interaction
        ? needsAttentionFromInteraction(consumer, interaction)
        : null;
      return buildWorkspaceAgentMessageCenterItem({
        session: consumer.session,
        messages: sessionMessages(snapshot.sessionMessagesById, consumer),
        status: consumer.displayStatus,
        needsAttention,
        pendingPrompt: interaction ? promptFromInteraction(interaction) : null,
        latestTurnOutcome: turnOutcome(consumer),
        options
      });
    });
  return buildWorkspaceAgentMessageCenterModelFromItems(
    items,
    options.itemCutoffUnixMs
  );
}

export interface WorkspaceAgentMessageCenterPresentation {
  consumers: readonly WorkspaceAgentConsumerSession[];
  promptStatusByKey: Readonly<
    Record<string, WorkspaceAgentMessageCenterPromptStatus>
  >;
}

export function selectWorkspaceAgentMessageCenterPresentation(
  state: AgentSessionEngineState
): WorkspaceAgentMessageCenterPresentation {
  const consumers = selectWorkspaceAgentConsumerSessions(state);
  const promptStatusByKey: Record<
    string,
    WorkspaceAgentMessageCenterPromptStatus
  > = {};
  for (const consumer of consumers) {
    const sessionId = consumer.session.agentSessionId;
    for (const interaction of consumer.pendingInteractions) {
      const response = selectEngineInteractionResponse(
        state,
        sessionId,
        interaction.turnId,
        interaction.requestId
      );
      if (response) {
        promptStatusByKey[promptStatusKey(sessionId, interaction.requestId)] =
          response.status;
      }
    }
    const turnId = consumer.latestTurn?.turnId ?? "";
    if (!turnId) continue;
    const decision = selectPlanDecisionForTurn(state, sessionId, turnId);
    if (decision) {
      promptStatusByKey[promptStatusKey(sessionId, turnId)] =
        decision.status === "requested" ? "responding" : decision.status;
      continue;
    }
    const feedbackPrefix = [
      "plan-implementation",
      consumer.session.workspaceId,
      sessionId,
      turnId,
      "feedback"
    ].join(":");
    const submit = selectPendingSubmitsForSession(state, sessionId).find(
      (record) => record.clientSubmitId.startsWith(feedbackPrefix)
    );
    if (submit) {
      promptStatusByKey[promptStatusKey(sessionId, turnId)] =
        submit.status === "failed"
          ? "failed"
          : submit.status === "uncertain"
            ? "unknown"
            : "responding";
    }
  }
  return {
    consumers,
    promptStatusByKey
  };
}

export function workspaceAgentMessageCenterPresentationEqual(
  left: WorkspaceAgentMessageCenterPresentation,
  right: WorkspaceAgentMessageCenterPresentation
): boolean {
  return (
    promptStatusMapsEqual(left.promptStatusByKey, right.promptStatusByKey) &&
    left.consumers.length === right.consumers.length &&
    left.consumers.every((item, index) => {
      const candidate = right.consumers[index];
      return (
        candidate !== undefined &&
        item.session === candidate.session &&
        item.activeTurn === candidate.activeTurn &&
        item.latestTurn === candidate.latestTurn &&
        item.displayStatus === candidate.displayStatus &&
        item.pendingInteractions.length ===
          candidate.pendingInteractions.length &&
        item.pendingInteractions.every(
          (interaction, interactionIndex) =>
            interaction === candidate.pendingInteractions[interactionIndex]
        )
      );
    })
  );
}

export type WorkspaceAgentMessageCenterPromptStatus =
  | "idle"
  | "responding"
  | "unknown"
  | "failed";

export function workspaceAgentMessageCenterPromptStatus(
  presentation: WorkspaceAgentMessageCenterPresentation,
  item: Pick<
    import("./workspaceAgentMessageCenterModel").WorkspaceAgentMessageCenterItem,
    "agentSessionId" | "pendingPrompt"
  >
): WorkspaceAgentMessageCenterPromptStatus {
  const prompt = item.pendingPrompt;
  if (!prompt) return "idle";
  return (
    presentation.promptStatusByKey[
      promptStatusKey(item.agentSessionId, prompt.requestId)
    ] ?? "idle"
  );
}

function promptStatusKey(agentSessionId: string, requestId: string): string {
  return `${agentSessionId}\0${requestId}`;
}

function promptStatusMapsEqual(
  left: Readonly<Record<string, WorkspaceAgentMessageCenterPromptStatus>>,
  right: Readonly<Record<string, WorkspaceAgentMessageCenterPromptStatus>>
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

function sessionMessages(
  sessionMessagesById: Readonly<Record<string, AgentActivityMessage[]>>,
  consumer: WorkspaceAgentConsumerSession
): readonly AgentActivityMessage[] {
  for (const id of [
    consumer.session.agentSessionId,
    consumer.session.providerSessionId
  ]) {
    const normalized = id?.trim() ?? "";
    if (normalized && sessionMessagesById[normalized]) {
      return sessionMessagesById[normalized];
    }
  }
  return [];
}

function latestPendingInteraction(
  consumer: WorkspaceAgentConsumerSession
): AgentActivityInteraction | null {
  return consumer.pendingInteractions.at(-1) ?? null;
}

function needsAttentionFromInteraction(
  consumer: WorkspaceAgentConsumerSession,
  interaction: AgentActivityInteraction
): AgentActivityNeedsAttentionItem {
  const summary = interactionSummary(interaction);
  return {
    id: `interaction:${interaction.requestId}`,
    workspaceId: consumer.session.workspaceId,
    agentSessionId: consumer.session.agentSessionId,
    provider: consumer.session.provider,
    title: summary,
    cwd: consumer.session.cwd,
    kind:
      interaction.kind === "approval"
        ? "permission"
        : interaction.kind === "question"
          ? "question"
          : "constraint",
    summary,
    occurredAtUnixMs: interaction.createdAtUnixMs
  };
}

function promptFromInteraction(
  interaction: AgentActivityInteraction
): AgentConversationPromptVM | null {
  const input = interaction.input ?? {};
  if (interaction.kind === "question") {
    const questions = normalizeAskUserQuestions(input.questions);
    return {
      kind: "ask-user",
      requestId: interaction.requestId,
      title: interactionSummary(interaction),
      questions:
        questions.length > 0
          ? questions
          : [
              {
                id: "response",
                header: "",
                question: interactionSummary(interaction),
                options: [],
                multiSelect: false,
                answer: null
              }
            ]
    };
  }
  if (interaction.kind !== "approval") {
    return null;
  }
  const options = arrayValue(input.options).flatMap((value) => {
    const option = recordValue(value);
    const id = textValue(option.optionId) ?? textValue(option.id);
    return id
      ? [
          {
            id,
            label: textValue(option.label) ?? textValue(option.name) ?? id,
            kind: textValue(option.kind) ?? id
          }
        ]
      : [];
  });
  return {
    kind: "approval",
    id: `approval:${interaction.requestId}`,
    turnId: interaction.turnId,
    requestId: interaction.requestId,
    callId: textValue(input.callId) ?? interaction.requestId,
    title: interactionSummary(interaction),
    toolName: interaction.toolName ?? null,
    status: interaction.status,
    input,
    options,
    output: interaction.output ?? null,
    occurredAtUnixMs: interaction.createdAtUnixMs
  };
}

function turnOutcome(
  consumer: WorkspaceAgentConsumerSession
): WorkspaceAgentMessageCenterTurnOutcome | null {
  const turn = consumer.latestTurn;
  if (!turn || turn.phase !== "settled") return null;
  const status =
    turn.outcome === "completed"
      ? "completed"
      : turn.outcome === "failed"
        ? "failed"
        : null;
  return status
    ? {
        notificationKey: `${consumer.session.agentSessionId}:turn:${turn.turnId}:${status}`,
        status,
        turnId: turn.turnId
      }
    : null;
}

function interactionSummary(interaction: AgentActivityInteraction): string {
  const input = interaction.input ?? {};
  return (
    textValue(input.question) ??
    textValue(input.title) ??
    textValue(input.summary) ??
    interaction.toolName?.trim() ??
    interaction.kind
  );
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
