import {
  AGENT_GUI_MENTION_PROVIDER_IDS,
  type AgentRichTextAtInsertResult,
  type AgentRichTextAtProvider
} from "@tutti-os/agent-gui/agent-rich-text-at-provider";

export interface DesktopAgentSessionStatusView {
  /** Localized activity status label (e.g. "Working"). */
  readonly label: string;
  /** Normalized activity status preserved as `data-status` (e.g. "working"). */
  readonly dataStatus: string;
  /** Whether the activity status dot should pulse. */
  readonly pulse: boolean;
}

export interface CreateDesktopAgentSessionMentionProviderInput {
  readonly baseProvider: AgentRichTextAtProvider;
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
}: CreateDesktopAgentSessionMentionProviderInput): AgentRichTextAtProvider {
  return {
    ...baseProvider,
    id: AGENT_GUI_MENTION_PROVIDER_IDS.agentSession,
    toInsertResult: (item) =>
      enrichAgentSessionInsertResult(baseProvider.toInsertResult(item), {
        resolveAgentIconUrl,
        userAvatarPlaceholderUrl,
        resolveStatusView
      })
  };
}

function enrichAgentSessionInsertResult(
  insertResult: AgentRichTextAtInsertResult,
  resolvers: Pick<
    CreateDesktopAgentSessionMentionProviderInput,
    "resolveAgentIconUrl" | "userAvatarPlaceholderUrl" | "resolveStatusView"
  >
): AgentRichTextAtInsertResult {
  if (insertResult.kind !== "mention") {
    return insertResult;
  }
  const meta = insertResult.mention.meta ?? {};
  const provider = meta.provider?.trim() ?? "";
  const initiatorName = meta.initiatorName?.trim() ?? "";
  const agentName = meta.agentName?.trim() ?? "";
  const status = meta.status?.trim() ?? "";
  const statusView = status ? resolvers.resolveStatusView(status) : null;
  return {
    ...insertResult,
    mention: {
      ...insertResult.mention,
      meta: {
        ...meta,
        agentIconUrl: resolvers.resolveAgentIconUrl(provider || agentName),
        participant: resolveSessionParticipant(initiatorName, agentName),
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

function resolveSessionParticipant(
  initiatorName: string,
  agentName: string
): string {
  if (initiatorName && agentName) {
    return `${initiatorName} & ${agentName}`;
  }
  return initiatorName || agentName;
}
