import {
  resolveAgentSessionMentionLinkAction,
  resolveWorkspaceUrlLinkAction,
  type OpenAgentSessionLinkAction,
  type OpenWorkspaceUrlLinkAction,
  type WorkspaceLinkActionSource
} from "../../../actions/portableWorkspaceNavigationActions";

export type AgentConversationNavigationAction =
  | OpenAgentSessionLinkAction
  | OpenWorkspaceUrlLinkAction;

/**
 * Cross-renderer baseline for conversation links.
 *
 * Workspace files, local assets, apps, issues, and custom mentions remain host
 * capabilities. Alternate renderers can share URL and Session navigation
 * without importing those host policies.
 */
export function resolveAgentConversationNavigationAction({
  href,
  source
}: {
  href: string;
  source: WorkspaceLinkActionSource;
}): AgentConversationNavigationAction | null {
  const mention = resolveAgentSessionMentionLinkAction({ href, source });
  if (mention) {
    return mention;
  }
  return resolveWorkspaceUrlLinkAction({ url: href, source });
}
