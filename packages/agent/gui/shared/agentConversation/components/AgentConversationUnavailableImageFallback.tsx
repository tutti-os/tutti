import type { JSX } from "react";
import { useTranslation } from "../../../i18n/index";
import type {
  AgentConversationUnavailableImageContext,
  AgentConversationUnavailableImageRenderer
} from "../contracts/agentConversationUnavailableImage";

export const renderDefaultAgentConversationUnavailableImage: AgentConversationUnavailableImageRenderer =
  (context) => <AgentConversationUnavailableImageFallback context={context} />;

export function resolveAgentConversationUnavailableImageRenderer(
  renderer: AgentConversationUnavailableImageRenderer | undefined
): AgentConversationUnavailableImageRenderer {
  return renderer ?? renderDefaultAgentConversationUnavailableImage;
}

function AgentConversationUnavailableImageFallback({
  context
}: {
  context: AgentConversationUnavailableImageContext;
}): JSX.Element {
  const { t } = useTranslation();
  const label = t("agentHost.agentGui.imagePreviewUnavailable");

  return (
    <span
      aria-label={label}
      className="flex min-h-20 w-full items-center justify-center rounded-[8px] bg-[var(--transparency-block)] px-3 py-2 text-center text-[12px] leading-5 text-[var(--text-tertiary)]"
      data-agent-conversation-unavailable-image-reason={context.reason}
      data-agent-conversation-unavailable-image-source={context.source}
      data-testid="agent-conversation-unavailable-image"
      role="img"
    >
      {label}
    </span>
  );
}
