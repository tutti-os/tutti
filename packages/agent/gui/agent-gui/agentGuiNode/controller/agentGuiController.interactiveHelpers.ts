// Agent GUI controller — approval and interactive prompt projection.

import type { AgentApprovalItemVM } from "../../../shared/agentConversation/contracts/agentApprovalItemVM";
import type { AgentConversationVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import type { AgentSessionState } from "../../../shared/agentSessionTypes";
import type {
  AgentGUIApprovalRequest,
  AgentGUIInteractivePrompt,
  AgentGUIInteractiveQuestion
} from "../model/agentGuiConversationModel";

export function pendingApprovalFromState(
  state: AgentSessionState | null
): AgentSessionState["pendingInteractive"] | null {
  return state?.pendingInteractive?.kind === "approval"
    ? state.pendingInteractive
    : null;
}

export function pendingInteractiveFromState(
  state: AgentSessionState | null
): AgentSessionState["pendingInteractive"] | null {
  if (!state?.pendingInteractive) {
    return null;
  }
  return state.pendingInteractive.kind === "approval"
    ? null
    : state.pendingInteractive;
}

export function promptRequestId(
  prompt: { requestId?: string | null } | null | undefined
): string | null {
  const requestId = prompt?.requestId?.trim() ?? "";
  return requestId || null;
}
export function approvalRequestFromConversation(
  conversation: AgentConversationVM | null
): AgentGUIApprovalRequest | null {
  return conversation?.pendingApproval ?? null;
}

export function interactivePromptFromConversation(
  conversation: AgentConversationVM | null
): AgentGUIInteractivePrompt | null {
  return conversation?.pendingInteractivePrompt ?? null;
}

export function interactiveApprovalFromSessionState(
  state: AgentSessionState | null
) {
  const prompt = state?.pendingInteractive;
  if (!prompt || prompt.kind !== "approval") {
    return null;
  }
  const callID =
    typeof prompt.input?.callId === "string" && prompt.input.callId.trim()
      ? prompt.input.callId.trim()
      : (prompt.requestId?.trim() ?? "");
  const options = Array.isArray(prompt.input?.options)
    ? prompt.input.options
    : [];
  const normalizedOptions = options
    .map((option) => {
      if (!option || typeof option !== "object") {
        return null;
      }
      const candidate = option as Record<string, unknown>;
      const id =
        typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : typeof candidate.optionId === "string" && candidate.optionId.trim()
            ? candidate.optionId.trim()
            : "";
      if (!id) {
        return null;
      }
      return {
        id,
        label:
          typeof candidate.name === "string" && candidate.name.trim()
            ? candidate.name.trim()
            : typeof candidate.label === "string" && candidate.label.trim()
              ? candidate.label.trim()
              : id,
        kind:
          typeof candidate.kind === "string" && candidate.kind.trim()
            ? candidate.kind.trim()
            : id,
        ...(typeof candidate.description === "string" &&
        candidate.description.trim()
          ? { description: candidate.description.trim() }
          : {})
      };
    })
    .filter(
      (
        option
      ): option is {
        id: string;
        label: string;
        kind: string;
        description?: string;
      } => option !== null
    );
  if (!prompt.requestId?.trim() || !callID || normalizedOptions.length === 0) {
    return null;
  }
  const approval: AgentApprovalItemVM = {
    kind: "approval",
    id: `approval:${callID}`,
    turnId: "turn:unknown",
    requestId: prompt.requestId.trim(),
    callId: callID,
    title:
      typeof prompt.toolName === "string" && prompt.toolName.trim()
        ? prompt.toolName.trim()
        : "Approval required",
    status: "waiting_approval",
    toolName:
      typeof prompt.toolName === "string" && prompt.toolName.trim()
        ? prompt.toolName.trim()
        : null,
    input: prompt.input ?? null,
    options: normalizedOptions,
    output: null,
    occurredAtUnixMs:
      typeof state?.updatedAtUnixMs === "number" ? state.updatedAtUnixMs : null
  };
  return approval;
}

export function interactivePromptFromSessionState(
  state: AgentSessionState | null
): AgentGUIInteractivePrompt | null {
  const prompt = state?.pendingInteractive;
  if (!prompt || prompt.kind === "approval" || !prompt.requestId?.trim()) {
    return null;
  }
  const toolName = normalizeInteractiveToolName(prompt.toolName);
  if (toolName === "exitplanmode") {
    return {
      kind: "exit-plan",
      requestId: prompt.requestId.trim(),
      title: prompt.toolName?.trim() || "Exit plan mode"
    };
  }
  if (toolName !== "askuserquestion") {
    return null;
  }
  const questions = normalizeInteractiveQuestions(prompt.input?.questions);
  if (questions.length === 0) {
    return null;
  }
  return {
    kind: "ask-user",
    requestId: prompt.requestId.trim(),
    title: prompt.toolName?.trim() || "Questions for you",
    questions
  };
}

export function normalizeInteractiveToolName(
  toolName: string | undefined
): string {
  return (toolName?.trim() ?? "").replace(/[_\s-]+/g, "").toLowerCase();
}

export function normalizeInteractiveQuestions(
  value: unknown
): AgentGUIInteractiveQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            return [];
          }
          const candidate = option as Record<string, unknown>;
          const label =
            typeof candidate.label === "string" && candidate.label.trim()
              ? candidate.label.trim()
              : typeof candidate.name === "string" && candidate.name.trim()
                ? candidate.name.trim()
                : "";
          if (!label) {
            return [];
          }
          return [
            {
              label,
              description:
                typeof candidate.description === "string"
                  ? candidate.description.trim()
                  : ""
            }
          ];
        })
      : [];
    const question =
      typeof record.question === "string" && record.question.trim()
        ? record.question.trim()
        : typeof record.header === "string" && record.header.trim()
          ? record.header.trim()
          : "";
    if (!question) {
      return [];
    }
    return [
      {
        id:
          typeof record.id === "string" && record.id.trim()
            ? record.id.trim()
            : `question-${index + 1}`,
        header:
          typeof record.header === "string" && record.header.trim()
            ? record.header.trim()
            : `Question ${index + 1}`,
        question,
        options,
        multiSelect: Boolean(record.multiSelect),
        isOther: Boolean(record.isOther)
      }
    ];
  });
}
