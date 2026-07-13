import type { AgentApprovalItemVM } from "../contracts/agentApprovalItemVM";
import type { AgentConversationPendingInteractivePromptVM } from "../contracts/agentConversationVM";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import type { AgentTranscriptRowVM } from "../contracts/agentTranscriptRowVM";

export function selectConversationPendingApproval(
  rows: readonly AgentTranscriptRowVM[]
): AgentApprovalItemVM | null {
  for (const row of [...rows].reverse()) {
    if (row.kind !== "tool-group") continue;
    for (const call of toolCallsFromRow(row).reverse()) {
      const nestedApproval = pendingApprovalFromNestedTask(call);
      if (nestedApproval) return nestedApproval;
      const approval = call.approval ?? fallbackApprovalFromCall(call);
      if (
        approval &&
        normalizeApprovalPendingStatus(
          approval.status ?? call.status,
          call.statusKind
        ) &&
        !approval.output
      ) {
        return approval;
      }
    }
  }
  return null;
}

function pendingApprovalFromNestedTask(
  call: AgentToolCallVM
): AgentApprovalItemVM | null {
  if (!call.task) return null;
  for (const step of [...call.task.steps].reverse()) {
    const stepCall = step.tool;
    if (!stepCall) continue;
    const nestedApproval = pendingApprovalFromNestedTask(stepCall);
    if (nestedApproval) return nestedApproval;
    const approval = stepCall.approval ?? fallbackApprovalFromCall(stepCall);
    if (
      approval &&
      normalizeApprovalPendingStatus(
        approval.status ?? stepCall.status,
        stepCall.statusKind
      ) &&
      !approval.output
    ) {
      return approval;
    }
  }
  return null;
}

export function selectConversationPendingInteractivePrompt(
  rows: readonly AgentTranscriptRowVM[]
): AgentConversationPendingInteractivePromptVM | null {
  for (const row of [...rows].reverse()) {
    if (row.kind !== "tool-group") continue;
    for (const call of toolCallsFromRow(row).reverse()) {
      const prompt = pendingInteractivePromptFromCall(call);
      if (prompt) return prompt;
    }
  }
  return null;
}

function pendingInteractivePromptFromCall(
  call: AgentToolCallVM
): AgentConversationPendingInteractivePromptVM | null {
  if (
    call.askUserQuestion &&
    normalizeInteractivePendingStatus(
      call.askUserQuestion.status ?? call.status,
      call.statusKind
    ) &&
    call.askUserQuestion.questions.some((question) => question.answer === null)
  ) {
    return {
      kind: "ask-user",
      requestId: call.askUserQuestion.requestId,
      title: call.askUserQuestion.title,
      questions: call.askUserQuestion.questions
    };
  }
  if (
    call.planMode?.kind === "exit" &&
    normalizeInteractivePendingStatus(
      call.planMode.status ?? call.status,
      call.statusKind
    )
  ) {
    return {
      kind: "exit-plan",
      requestId: call.planMode.requestId ?? call.id.replace(/^call:/, ""),
      title: call.planMode.title,
      options: call.planMode.options ?? [],
      ...(call.planMode.keepPlanningOptionId
        ? { keepPlanningOptionId: call.planMode.keepPlanningOptionId }
        : {})
    };
  }
  if (!call.task) return null;
  for (const step of [...call.task.steps].reverse()) {
    if (!step.tool) continue;
    const prompt = pendingInteractivePromptFromCall(step.tool);
    if (prompt) return prompt;
  }
  return null;
}

function toolCallsFromRow(
  row: Extract<AgentTranscriptRowVM, { kind: "tool-group" }>
): AgentToolCallVM[] {
  return row.calls.length > 0
    ? [...row.calls]
    : row.entries.flatMap((entry) =>
        entry.kind === "tool-call" ? [entry.call] : []
      );
}

function normalizeApprovalPendingStatus(
  value: string | null | undefined,
  statusKind: AgentToolCallVM["statusKind"]
): boolean {
  if (statusKind === "waiting") return true;
  const normalized = (value ?? "").trim().toLowerCase();
  return [
    "awaiting_approval",
    "requested",
    "waiting_approval",
    "waiting"
  ].includes(normalized);
}

function normalizeInteractivePendingStatus(
  value: string | null | undefined,
  statusKind: AgentToolCallVM["statusKind"]
): boolean {
  if (statusKind === "waiting" || statusKind === "working") return true;
  const normalized = (value ?? "").trim().toLowerCase();
  return [
    "waiting_input",
    "waiting",
    "pending",
    "running",
    "streaming",
    "working"
  ].includes(normalized);
}

function fallbackApprovalFromCall(
  call: AgentToolCallVM
): AgentApprovalItemVM | null {
  if (call.rendererKind !== "approval") return null;
  const rawOptions = Array.isArray(call.input?.options)
    ? call.input.options
    : [];
  const options = rawOptions.flatMap((option) => {
    const record =
      option && typeof option === "object" && !Array.isArray(option)
        ? (option as Record<string, unknown>)
        : null;
    const id =
      typeof record?.id === "string" && record.id.trim()
        ? record.id.trim()
        : typeof record?.optionId === "string" && record.optionId.trim()
          ? record.optionId.trim()
          : "";
    if (!id) return [];
    return [
      {
        id,
        label:
          typeof record?.name === "string" && record.name.trim()
            ? record.name.trim()
            : typeof record?.label === "string" && record.label.trim()
              ? record.label.trim()
              : id,
        kind:
          typeof record?.kind === "string" && record.kind.trim()
            ? record.kind.trim()
            : id,
        ...(typeof record?.description === "string" && record.description.trim()
          ? { description: record.description.trim() }
          : {})
      }
    ];
  });
  const requestId =
    (typeof call.input?.requestId === "string" && call.input.requestId.trim()
      ? call.input.requestId.trim()
      : null) ?? call.id.replace(/^call:/, "");
  if (!requestId || options.length === 0) return null;
  return {
    kind: "approval",
    id: call.id,
    turnId: call.turnId,
    requestId,
    callId: call.id.replace(/^call:/, ""),
    title: call.summary.trim() || call.name,
    status:
      typeof call.payload?.status === "string" && call.payload.status.trim()
        ? call.payload.status.trim()
        : call.status,
    toolName: call.toolName,
    input: call.input,
    options,
    output: call.output,
    occurredAtUnixMs: call.occurredAtUnixMs
  };
}
