import { WorkspaceScopedRegistrationRegistry } from "./internal/workspaceScopedRegistrationRegistry.ts";

export interface GroupChatLaunchRequest {
  conversationId?: string | null;
  messageId?: string | null;
  summaryTaskId?: string | null;
  workspaceId: string;
}

export type GroupChatLaunchHandler = (
  request: GroupChatLaunchRequest
) => Promise<boolean> | boolean;

const launchHandlers =
  new WorkspaceScopedRegistrationRegistry<GroupChatLaunchHandler>();

export function registerGroupChatLaunchHandler(
  workspaceId: string,
  handler: GroupChatLaunchHandler
): () => void {
  return launchHandlers.register(workspaceId, handler);
}

export async function requestGroupChatLaunch(
  request: GroupChatLaunchRequest
): Promise<boolean> {
  const normalized = normalizeGroupChatLaunchRequest(request);
  if (!normalized) {
    return false;
  }

  const handler = launchHandlers.get(normalized.workspaceId);
  if (!handler) {
    return false;
  }

  return handler(normalized);
}

export function buildGroupChatDeepLinkUrl(
  baseUrl: string,
  params: {
    conversationId?: string | null;
    messageId?: string | null;
    summaryTaskId?: string | null;
  }
): string {
  const url = new URL(baseUrl);
  const search = new URLSearchParams();
  const messageId = normalizeOptionalString(params.messageId);
  const summaryTaskId = normalizeOptionalString(params.summaryTaskId);
  const conversationId = normalizeOptionalString(params.conversationId);
  if (messageId) search.set("messageId", messageId);
  if (summaryTaskId) search.set("summaryTaskId", summaryTaskId);
  if (conversationId) search.set("conversationId", conversationId);
  const query = search.toString();
  url.hash = query ? `nav?${query}` : "";
  return url.toString();
}

function normalizeGroupChatLaunchRequest(
  request: GroupChatLaunchRequest
): GroupChatLaunchRequest | null {
  const workspaceId = request.workspaceId.trim();
  if (!workspaceId) {
    return null;
  }

  const messageId = normalizeOptionalString(request.messageId);
  const summaryTaskId = normalizeOptionalString(request.summaryTaskId);
  const conversationId = normalizeOptionalString(request.conversationId);
  if (!messageId && !summaryTaskId) {
    return { workspaceId };
  }

  return {
    workspaceId,
    ...(messageId ? { messageId } : {}),
    ...(summaryTaskId ? { summaryTaskId } : {}),
    ...(conversationId ? { conversationId } : {})
  };
}

function normalizeOptionalString(
  value: string | null | undefined
): string | undefined {
  const normalized = value?.trim() || "";
  return normalized || undefined;
}
