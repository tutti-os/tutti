import {
  AGENT_CONTEXT_MENTION_PROVIDER_IDS,
  type AgentContextMentionInsertResult,
  type AgentContextMentionProvider
} from "@tutti-os/agent-gui/context-mention-provider";

export interface DesktopAgentSessionStatusView {
  /** Localized activity status label (e.g. "Working"). */
  readonly label: string;
  /** Normalized activity status preserved as `data-status` (e.g. "working"). */
  readonly dataStatus: string;
  /** Whether the activity status dot should pulse. */
  readonly pulse: boolean;
}

export interface CreateDesktopAgentSessionMentionProviderInput {
  readonly baseProvider: AgentContextMentionProvider;
  /** Resolve the rounded managed-agent icon URL for a session's provider. */
  readonly resolveAgentIconUrl: (provider: string) => string;
  /** The bundled user-avatar placeholder asset URL. */
  readonly userAvatarPlaceholderUrl: string;
  /**
   * Resolve a session's raw status into the display-ready activity status view
   * (localized label + normalized data-status + pulse), or null when there is no
   * status. Injected so the agent-app-coupled i18n/normalization stays at the
   * desktop contribution seam and this provider stays asset-free and testable.
   */
  readonly resolveStatusView: (
    status: string
  ) => DesktopAgentSessionStatusView | null;
}

/**
 * Wrap the raw desktop `agent-session` mention provider so its match meta
 * carries the SAME session visuals the agent composer renders: the rounded
 * managed-agent provider icon, the user avatar placeholder asset, the
 * "initiator & agent" participant line, and a resolved activity status badge
 * (label + data-status + pulse). issue-manager then reads these from `meta` and
 * renders the shared `renderMentionRow` session row identically to the agent.
 *
 * Asset/i18n resolution is INJECTED (the desktop contribution seam owns the
 * agent-app-coupled helpers/assets), so this module imports no agent-app assets
 * and stays unit-testable. Only `toInsertResult` is augmented; everything else
 * delegates to the base provider unchanged.
 */
export function createDesktopAgentSessionMentionProvider({
  baseProvider,
  resolveAgentIconUrl,
  userAvatarPlaceholderUrl,
  resolveStatusView
}: CreateDesktopAgentSessionMentionProviderInput): AgentContextMentionProvider {
  return {
    ...baseProvider,
    id: AGENT_CONTEXT_MENTION_PROVIDER_IDS.agentSession,
    toInsertResult: (item) =>
      enrichAgentSessionInsertResult(baseProvider.toInsertResult(item), {
        resolveAgentIconUrl,
        userAvatarPlaceholderUrl,
        resolveStatusView
      })
  };
}

function enrichAgentSessionInsertResult(
  insertResult: AgentContextMentionInsertResult,
  resolvers: Pick<
    CreateDesktopAgentSessionMentionProviderInput,
    "resolveAgentIconUrl" | "userAvatarPlaceholderUrl" | "resolveStatusView"
  >
): AgentContextMentionInsertResult {
  if (insertResult.kind !== "mention") {
    return insertResult;
  }
  const presentation = insertResult.mention.presentation ?? {};
  const provider =
    presentation.agentProviderId?.trim() || presentation.subtitle?.trim() || "";
  const participant = presentation.participant?.trim() ?? "";
  const agentName = provider || insertResult.mention.label.trim();
  const status = presentation.status?.trim() ?? "";
  const statusView = status ? resolvers.resolveStatusView(status) : null;
  return {
    ...insertResult,
    mention: {
      ...insertResult.mention,
      presentation: {
        ...presentation,
        agentIconUrl: resolvers.resolveAgentIconUrl(provider || agentName),
        participant: participant || agentName,
        userAvatarPlaceholderUrl: resolvers.userAvatarPlaceholderUrl,
        ...(statusView
          ? {
              statusDataStatus: statusView.dataStatus,
              statusLabel: statusView.label,
              statusPulse: statusView.pulse ? "true" : "false"
            }
          : {})
      }
    }
  };
}
