import type {
  AgentHostUserProject,
  AgentHostUserProjectsApi
} from "../../../host/agentHostApi";
import type { AgentActivityInteraction } from "@tutti-os/agent-activity-core";
import type {
  AgentGUIApprovalRequest,
  AgentGUIInteractivePrompt,
  AgentGUIInteractiveQuestion
} from "../model/agentGuiConversationModel";
import { normalizeAgentApprovalPurpose } from "../../../shared/agentConversation/agentApprovalPurpose";
export function normalizeProjectConversationPath(
  path: string | null | undefined
): string {
  const normalized = path?.trim().replaceAll("\\", "/") ?? "";
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/+$/, "") || "/";
}

export function omitConversationLocalState<T>(
  current: Record<string, T>,
  conversationIds: ReadonlySet<string>
): Record<string, T> {
  let changed = false;
  const next = { ...current };
  for (const conversationId of conversationIds) {
    if (conversationId in next) {
      delete next[conversationId];
      changed = true;
    }
  }
  return changed ? next : current;
}

export function interactiveApprovalFromInteraction(
  interaction: AgentActivityInteraction | null
): AgentGUIApprovalRequest | null {
  if (!interaction || interaction.kind !== "approval") return null;
  const callId =
    typeof interaction.input?.callId === "string" &&
    interaction.input.callId.trim()
      ? interaction.input.callId.trim()
      : interaction.requestId.trim();
  const options = Array.isArray(interaction.input?.options)
    ? interaction.input.options
    : [];
  const normalizedOptions = options
    .map((option) => {
      if (!option || typeof option !== "object") return null;
      const candidate = option as Record<string, unknown>;
      const id =
        typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : typeof candidate.optionId === "string" && candidate.optionId.trim()
            ? candidate.optionId.trim()
            : "";
      if (!id) return null;
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
    .filter((option): option is NonNullable<typeof option> => option !== null);
  if (!callId || normalizedOptions.length === 0) return null;
  const approvalPurpose = normalizeAgentApprovalPurpose(
    interaction.metadata?.approvalPurpose
  );
  return {
    kind: "approval",
    id: `approval:${callId}`,
    turnId: interaction.turnId,
    requestId: interaction.requestId,
    callId,
    ...(approvalPurpose ? { approvalPurpose } : {}),
    title: interaction.toolName?.trim() || "Approval required",
    status: "waiting_approval",
    toolName: interaction.toolName?.trim() || null,
    input: interaction.input ?? null,
    options: normalizedOptions,
    output: interaction.output ?? null,
    occurredAtUnixMs: interaction.createdAtUnixMs
  };
}

export function interactivePromptFromInteraction(
  interaction: AgentActivityInteraction | null
): AgentGUIInteractivePrompt | null {
  if (!interaction || interaction.kind === "approval") return null;
  const toolName = normalizeInteractiveToolName(
    interaction.toolName ?? undefined
  );
  if (interaction.kind === "plan" || toolName === "exitplanmode") {
    return {
      kind: "exit-plan",
      requestId: interaction.requestId,
      title: interaction.toolName?.trim() || "Exit plan mode",
      options: []
    };
  }
  if (interaction.kind !== "question" || toolName !== "askuserquestion") {
    return null;
  }
  const questions = normalizeInteractiveQuestions(interaction.input?.questions);
  return questions.length > 0
    ? {
        kind: "ask-user",
        requestId: interaction.requestId,
        title: interaction.toolName?.trim() || "Questions for you",
        questions
      }
    : null;
}

export function normalizeInteractiveToolName(
  toolName: string | undefined
): string {
  return (toolName?.trim() ?? "").replace(/[_\s-]+/g, "").toLowerCase();
}

export function areAgentGUIUserProjectsEqual(
  left: readonly AgentHostUserProject[],
  right: readonly AgentHostUserProject[]
): boolean {
  return (
    left.length === right.length &&
    left.every((project, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        project.id === candidate.id &&
        project.path === candidate.path &&
        project.label === candidate.label
      );
    })
  );
}

export function upsertAgentGUIUserProject(
  projects: readonly AgentHostUserProject[],
  project: {
    id: string;
    path: string;
    label: string;
    createdAtUnixMs?: number;
    updatedAtUnixMs?: number;
    lastUsedAtUnixMs?: number | null;
  }
): AgentHostUserProject[] {
  const normalizedProject: AgentHostUserProject = {
    ...(project.createdAtUnixMs === undefined
      ? {}
      : { createdAtUnixMs: project.createdAtUnixMs }),
    id: project.id,
    ...(project.lastUsedAtUnixMs === undefined ||
    project.lastUsedAtUnixMs === null
      ? {}
      : { lastUsedAtUnixMs: project.lastUsedAtUnixMs }),
    label: project.label,
    path: project.path,
    ...(project.updatedAtUnixMs === undefined
      ? {}
      : { updatedAtUnixMs: project.updatedAtUnixMs })
  };
  const index = projects.findIndex(
    (candidate) =>
      candidate.id === normalizedProject.id ||
      candidate.path === normalizedProject.path
  );
  if (index === -1) {
    return [...projects, normalizedProject];
  }
  const next = [...projects];
  next[index] = normalizedProject;
  return next;
}

export function readAgentGUIUserProjectSnapshot(
  api: AgentHostUserProjectsApi | undefined
): AgentHostUserProject[] {
  const projects = api?.service?.getSnapshot?.().projects ?? [];
  return projects.map((project) => ({
    ...(project.createdAtUnixMs === undefined
      ? {}
      : { createdAtUnixMs: project.createdAtUnixMs }),
    id: project.id,
    ...(project.lastUsedAtUnixMs === undefined ||
    project.lastUsedAtUnixMs === null
      ? {}
      : { lastUsedAtUnixMs: project.lastUsedAtUnixMs }),
    label: project.label,
    path: project.path,
    ...(project.updatedAtUnixMs === undefined
      ? {}
      : { updatedAtUnixMs: project.updatedAtUnixMs })
  }));
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
