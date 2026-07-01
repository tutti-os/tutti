import type { WorkspaceAgentSessionDetailToolCall } from "../../workspaceAgentSessionDetailViewModel";
import type { AgentAskUserQuestionItemVM } from "../contracts/agentAskUserQuestionItemVM";
import type { AgentPlanModeItemVM } from "../contracts/agentPlanModeItemVM";
import { normalizeAskUserQuestions } from "../askUserQuestions";
import {
  extractExitPlanKeepPlanningOptionId,
  extractExitPlanModeOptions,
  isExitPlanSwitchModeInput
} from "../exitPlanOptions";

export function projectAgentAskUserQuestionItem(
  call: WorkspaceAgentSessionDetailToolCall,
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null
): AgentAskUserQuestionItemVM | null {
  if (normalizeToolName(call.toolName) !== "askuserquestion") {
    return null;
  }
  const questions = normalizeAskUserQuestions(input?.questions);
  if (questions.length === 0) {
    return null;
  }
  const answersByQuestionId = objectValue(output?.answersByQuestionId) ?? {};
  return {
    kind: "ask-user",
    id: call.id,
    turnId: call.turnId ?? "turn:unknown",
    requestId:
      stringValue(input?.requestId) ??
      stringValue(call.payload?.requestId) ??
      call.id.replace(/^call:/, ""),
    title: call.name,
    status: call.status,
    questions: questions.map((question) => ({
      ...question,
      answer: answerForQuestion(question.id, answersByQuestionId, output)
    })),
    occurredAtUnixMs: call.occurredAtUnixMs ?? null
  };
}

export function projectAgentPlanModeItem(
  call: WorkspaceAgentSessionDetailToolCall,
  input: Record<string, unknown> | null
): AgentPlanModeItemVM | null {
  if (isExitPlanSwitchModeInput(input)) {
    return {
      itemKind: "plan-mode",
      id: call.id,
      turnId: call.turnId ?? "turn:unknown",
      requestId:
        stringValue(input?.requestId) ??
        stringValue(call.payload?.requestId) ??
        call.id.replace(/^call:/, ""),
      kind: "exit",
      title: stringValue(objectValue(input?.toolCall)?.title) ?? call.name,
      status: call.status,
      plan:
        stringValue(input?.plan) ??
        stringValue(call.payload?.plan) ??
        (call.summary.trim() || null),
      filePath:
        stringValue(input?.filePath) ?? stringValue(call.payload?.filePath),
      options: extractExitPlanModeOptions(input),
      ...keepPlanningOption(extractExitPlanKeepPlanningOptionId(input)),
      occurredAtUnixMs: call.occurredAtUnixMs ?? null
    };
  }
  const toolName = normalizeToolName(call.toolName);
  if (toolName === "enterplanmode") {
    return {
      itemKind: "plan-mode",
      id: call.id,
      turnId: call.turnId ?? "turn:unknown",
      kind: "enter",
      title: call.name,
      status: call.status,
      plan: stringValue(input?.content) ?? (call.summary.trim() || null),
      filePath: stringValue(input?.filePath),
      occurredAtUnixMs: call.occurredAtUnixMs ?? null
    };
  }
  if (toolName !== "exitplanmode") {
    return null;
  }
  return {
    itemKind: "plan-mode",
    id: call.id,
    turnId: call.turnId ?? "turn:unknown",
    requestId:
      stringValue(input?.requestId) ??
      stringValue(call.payload?.requestId) ??
      call.id.replace(/^call:/, ""),
    kind: "exit",
    title: call.name,
    status: call.status,
    plan:
      stringValue(input?.plan) ??
      stringValue(call.payload?.plan) ??
      (call.summary.trim() || null),
    filePath:
      stringValue(input?.filePath) ?? stringValue(call.payload?.filePath),
    occurredAtUnixMs: call.occurredAtUnixMs ?? null
  };
}

function answerForQuestion(
  questionId: string,
  answersByQuestionId: Record<string, unknown>,
  output: Record<string, unknown> | null
): string | string[] | null {
  const value = answersByQuestionId[questionId];
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      typeof item === "string" && item.trim() ? [item.trim()] : []
    );
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  const answers = arrayValue(output?.answers);
  return answers && answers.length > 0
    ? answers.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0
      )
    : null;
}

function keepPlanningOption(optionId: string | null): {
  keepPlanningOptionId?: string;
} {
  return optionId ? { keepPlanningOptionId: optionId } : {};
}

function normalizeToolName(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[_\s-]+/g, "")
    .trim()
    .toLowerCase();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
