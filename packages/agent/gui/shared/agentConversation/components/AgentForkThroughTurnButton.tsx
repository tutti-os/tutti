import { GitFork } from "lucide-react";
import type { JSX } from "react";
import { translate } from "../../../i18n/index";
import { CanvasNodeGhostIconButton } from "../../../contexts/workspace/presentation/renderer/components/shared/CanvasNodeGhostIconButton";
import styles from "../../../agent-gui/agentGuiNode/AgentGUIConversation.styles";

export function AgentForkThroughTurnButton({
  disabled,
  revealOnMessageHover = true,
  onFork
}: {
  disabled?: boolean;
  revealOnMessageHover?: boolean;
  onFork: () => void;
}): JSX.Element {
  return (
    <CanvasNodeGhostIconButton
      className={
        revealOnMessageHover
          ? styles.messageCopyButton
          : "static h-[22px] min-h-[22px] w-[22px] min-w-[22px] rounded-[5px]"
      }
      aria-label={translate("agentHost.agentGui.forkThroughTurn")}
      disabled={disabled}
      onClick={onFork}
    >
      <GitFork width={14} height={14} aria-hidden="true" />
    </CanvasNodeGhostIconButton>
  );
}

export function AgentForkThroughTurnFooter({
  disabled,
  onFork
}: {
  disabled?: boolean;
  onFork: () => void;
}): JSX.Element {
  return (
    <div
      className="mt-1 flex min-h-[26px] items-center"
      data-agent-turn-footer="true"
    >
      <AgentForkThroughTurnButton
        disabled={disabled}
        revealOnMessageHover={false}
        onFork={onFork}
      />
    </div>
  );
}
