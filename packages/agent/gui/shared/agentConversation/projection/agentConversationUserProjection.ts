import { linkifyPastedTextReferences } from "../../../agent-gui/agentGuiNode/model/agentComposerDraft";
import type { WorkspaceAgentSessionDetailTurn } from "../../workspaceAgentSessionDetailViewModel";
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
  return {
    kind: "message",
    id: `message:user:${message.id}`,
    turnId,
    speaker: "user",
    messages: projectUserMessageContentParts(message, turnId, workspaceId),
    thinking: [],
    occurredAtUnixMs: message.occurredAtUnixMs ?? null
  };
}

function projectUserMessageContentParts(
  message: WorkspaceAgentSessionDetailTurn["userMessages"][number],
  turnId: string,
  workspaceId: string | null | undefined
): AgentMessageContentVM[] {
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
        path: image.path,
        uri: image.uri,
        hostPath: image.hostPath,
        assetId: image.assetId,
        kind: image.kind,
        uploadStatus: image.uploadStatus,
        storagePolicy: image.storagePolicy
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
  uri?: string | null;
  hostPath?: string | null;
  assetId?: string | null;
  kind?: string | null;
  uploadStatus?: string | null;
  storagePolicy?: string | null;
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
  const blocks = content.flatMap((raw): UserPromptContentBlock[] => {
    const block =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    if (!block) return [];
    if (block.type === "text" && typeof block.text === "string") {
      return visibleDisplayPrompt
        ? []
        : [{ type: "text", text: linkifyPastedTextReferences(block.text) }];
    }
    if (block.type !== "image") return [];
    const mimeType =
      typeof block.mimeType === "string" ? block.mimeType.trim() : "";
    if (!mimeType) return [];
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
        path: optionalString(block.path),
        uri: optionalString(block.uri),
        hostPath: optionalString(block.hostPath),
        assetId: optionalString(block.assetId),
        kind: optionalString(block.kind),
        uploadStatus: optionalString(block.uploadStatus),
        storagePolicy: optionalString(block.storagePolicy)
      }
    ];
  });
  return visibleDisplayPrompt
    ? [{ type: "text", text: visibleDisplayPrompt }, ...blocks]
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
