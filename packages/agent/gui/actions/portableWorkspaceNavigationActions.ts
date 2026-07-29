import { parseRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import { resolveWebsiteNavigationUrl } from "../shared/utils/websiteUrl";

export type WorkspaceLinkActionSource =
  | "agent-markdown"
  | "agent-file-change"
  | string;

export const AGENT_EXTERNAL_LINK_ACTION_SOURCE = "agent-external-action";

export interface OpenWorkspaceUrlLinkAction {
  type: "open-url";
  url: string;
  source: WorkspaceLinkActionSource;
}

export interface OpenAgentSessionLinkAction {
  type: "open-agent-session";
  workspaceId: string;
  agentSessionId: string;
  agentTargetId?: string | null;
  source: WorkspaceLinkActionSource;
}

export interface ResolveWorkspaceUrlLinkActionInput {
  url: string;
  source: WorkspaceLinkActionSource;
}

export interface ResolveAgentSessionMentionLinkActionInput {
  href: string;
  source: WorkspaceLinkActionSource;
}

export function resolveWorkspaceUrlLinkAction({
  url,
  source
}: ResolveWorkspaceUrlLinkActionInput): OpenWorkspaceUrlLinkAction | null {
  const resolved = resolveWebsiteNavigationUrl(url);
  if (!resolved.url || resolved.error) {
    return null;
  }

  return {
    type: "open-url",
    url: resolved.url,
    source
  };
}

export function resolveAgentSessionMentionLinkAction({
  href,
  source
}: ResolveAgentSessionMentionLinkActionInput): OpenAgentSessionLinkAction | null {
  const mention = parseRichTextMentionHref(href, "");
  if (!mention || mention.providerId !== "agent-session") {
    return null;
  }

  const workspaceId = mention.scope?.workspaceId?.trim() || "";
  const agentSessionId = mention.entityId.trim();
  if (!workspaceId || !agentSessionId) {
    return null;
  }

  const agentTargetId = mention.scope?.agentTargetId?.trim() || null;
  return {
    type: "open-agent-session",
    workspaceId,
    agentSessionId,
    ...(agentTargetId ? { agentTargetId } : {}),
    source
  };
}
