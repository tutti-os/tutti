import type { WorkspaceAgentSessionDetailTurn } from "../../workspaceAgentSessionDetailViewModel";
import { linkifyPastedTextReferences } from "../../pastedTextReferenceProjection";
import { parseTuttiModeCheckpointWake } from "../tuttiModeCheckpointWakeMarker";
import type {
  AgentMessageContentVM,
  AgentMessageRowVM
} from "../contracts/agentMessageRowVM";

export function projectConversationUserRow(
  message: WorkspaceAgentSessionDetailTurn["userMessages"][number],
  fallbackTurnId: string,
  workspaceId: string | null | undefined
): AgentMessageRowVM {
  const turnId = message.turnId ?? fallbackTurnId;
  const rawFirstTextBlock = firstRawUserPromptTextBlock(message);
  return {
    kind: "message",
    id: `message:user:${message.id}`,
    turnId,
    speaker: "user",
    rawFirstTextBlock,
    messages: projectUserMessageContentParts(
      message,
      turnId,
      workspaceId,
      rawFirstTextBlock
    ),
    thinking: [],
    occurredAtUnixMs: message.occurredAtUnixMs ?? null
  };
}

// A daemon checkpoint-wake prompt is detected by its agent-inert sentinel line
// (parseTuttiModeCheckpointWake), never by matching the prompt prose. When
// present we render a single compact summary card instead of the wall of text;
// the full prompt stays available behind the card's expand affordance.
function tuttiModeCheckpointWakePart(
  message: WorkspaceAgentSessionDetailTurn["userMessages"][number],
  turnId: string,
  rawFirstTextBlock: string | null
): AgentMessageContentVM | null {
  const parsed = parseTuttiModeCheckpointWake(rawFirstTextBlock);
  if (!parsed) {
    return null;
  }
  return {
    kind: "message-content",
    id: `${message.id}:checkpoint-wake`,
    turnId,
    body: parsed.body,
    presentationKind: "content",
    contentKind: "tutti-checkpoint-wake",
    checkpointWake: parsed.marker,
    copyText: parsed.body,
    occurredAtUnixMs: message.occurredAtUnixMs ?? null,
    sourceTimelineItems: message.sourceTimelineItems
  };
}

function firstRawUserPromptTextBlock(
  message: WorkspaceAgentSessionDetailTurn["userMessages"][number]
): string | null {
  for (const item of message.sourceTimelineItems ?? []) {
    const content = item.payload?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const raw of content) {
      const block =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      if (block?.type === "text" && typeof block.text === "string") {
        return block.text;
      }
    }
  }
  return null;
}

function projectUserMessageContentParts(
  message: WorkspaceAgentSessionDetailTurn["userMessages"][number],
  turnId: string,
  workspaceId: string | null | undefined,
  rawFirstTextBlock: string | null
): AgentMessageContentVM[] {
  const checkpointWake = tuttiModeCheckpointWakePart(
    message,
    turnId,
    rawFirstTextBlock
  );
  if (checkpointWake) {
    return [checkpointWake];
  }
  const blocks = userPromptContentBlocks(message, workspaceId);
  if (blocks.length === 0) {
    return [textPart(message, turnId)];
  }
  const parts: AgentMessageContentVM[] = [];
  const imageBlocks = blocks.filter(
    (block): block is UserPromptImageBlock => block.type === "image"
  );
  if (imageBlocks.length > 0) {
    parts.push({
      kind: "message-content",
      id: `${message.id}:images:0`,
      turnId,
      body: "",
      presentationKind: "content",
      contentKind: "image-grid",
      images: imageBlocks.map((image, index) => ({
        id: `${message.id}:image:${index}`,
        workspaceId: image.workspaceId,
        agentSessionId: image.agentSessionId,
        attachmentId: image.attachmentId,
        mimeType: image.mimeType,
        name: image.name,
        data: image.data,
        url: image.url,
        path: image.path
      })),
      occurredAtUnixMs: message.occurredAtUnixMs ?? null,
      sourceTimelineItems: message.sourceTimelineItems
    });
  }
  blocks.forEach((block, index) => {
    if (block.type === "image" || block.text.trim() === "") return;
    parts.push({
      kind: "message-content",
      id: `${message.id}:text:${index}`,
      turnId,
      body: block.text,
      presentationKind: "content",
      contentKind: "text",
      occurredAtUnixMs: message.occurredAtUnixMs ?? null,
      sourceTimelineItems: message.sourceTimelineItems
    });
  });
  return parts.length > 0 ? parts : [textPart(message, turnId)];
}

function textPart(
  message: WorkspaceAgentSessionDetailTurn["userMessages"][number],
  turnId: string
): AgentMessageContentVM {
  return {
    kind: "message-content",
    id: message.id,
    turnId,
    body: message.body,
    presentationKind: "content",
    contentKind: "text",
    occurredAtUnixMs: message.occurredAtUnixMs ?? null,
    sourceTimelineItems: message.sourceTimelineItems
  };
}

type UserPromptContentBlock = UserPromptTextBlock | UserPromptImageBlock;

interface UserPromptTextBlock {
  type: "text";
  text: string;
}

interface UserPromptImageBlock {
  type: "image";
  workspaceId?: string | null;
  agentSessionId: string;
  attachmentId?: string | null;
  mimeType: string;
  name?: string | null;
  data?: string | null;
  url?: string | null;
  path?: string | null;
}

function userPromptContentBlocks(
  message: WorkspaceAgentSessionDetailTurn["userMessages"][number],
  fallbackWorkspaceId: string | null | undefined
): UserPromptContentBlock[] {
  const item = message.sourceTimelineItems?.find((candidate) =>
    Array.isArray(candidate.payload?.content)
  );
  const content = Array.isArray(item?.payload?.content)
    ? item.payload.content
    : null;
  if (!content) return [];
  const displayPrompt = firstString(
    message.sourceTimelineItems?.map((candidate) =>
      typeof candidate.payload?.displayPrompt === "string"
        ? candidate.payload.displayPrompt
        : ""
    ) ?? []
  );
  const visibleDisplayPrompt = isSyntheticImageOnlyDisplayPrompt(
    displayPrompt,
    content
  )
    ? ""
    : displayPrompt;
  // Older sessions kept draft-only `mention://composer-file/...` chips in
  // displayPrompt. Prefer the already-materialized provider text so transcript
  // clicks resolve through ordinary file locators.
  const preferMaterializedContentText =
    Boolean(visibleDisplayPrompt) &&
    visibleDisplayPrompt.includes("mention://composer-file/") &&
    content.some((raw) => {
      const block =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      return (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim().length > 0
      );
    });
  const effectiveDisplayPrompt = preferMaterializedContentText
    ? ""
    : visibleDisplayPrompt;
  const blocks = content.flatMap((raw): UserPromptContentBlock[] => {
    const block =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    if (!block) return [];
    if (block.type === "text" && typeof block.text === "string") {
      return effectiveDisplayPrompt
        ? []
        : [{ type: "text", text: linkifyPastedTextReferences(block.text) }];
    }
    if (block.type !== "image") return [];
    const mimeType =
      typeof block.mimeType === "string" ? block.mimeType.trim() : "";
    return [
      {
        type: "image",
        workspaceId: item?.workspaceId ?? fallbackWorkspaceId ?? null,
        agentSessionId: item?.agentSessionId ?? message.id,
        attachmentId: optionalString(block.attachmentId),
        mimeType,
        name: optionalString(block.name),
        data: optionalString(block.data),
        url: optionalString(block.url),
        path: optionalString(block.path)
      }
    ];
  });
  return effectiveDisplayPrompt
    ? [{ type: "text", text: effectiveDisplayPrompt }, ...blocks]
    : blocks;
}

function isSyntheticImageOnlyDisplayPrompt(
  displayPrompt: string,
  content: readonly unknown[]
): boolean {
  if (displayPrompt !== "[Image]" && displayPrompt !== "[Images]") {
    return false;
  }
  let imageCount = 0;
  for (const raw of content) {
    const block =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    if (!block) continue;
    if (
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim()
    ) {
      return false;
    }
    if (block.type === "image") {
      imageCount += 1;
    }
  }
  return displayPrompt === "[Image]" ? imageCount === 1 : imageCount > 1;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstString(values: readonly string[]): string {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}
