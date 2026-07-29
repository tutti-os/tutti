import { useMemo } from "react";
import { translate } from "../../../i18n";
import type { AgentTranscriptEditRetryControl } from "../../../shared/agentConversation/components/useAgentTranscriptEditRetryProjection";
import { useAgentGUIEditRetryController } from "../controller/useAgentGUIEditRetryController";

export function useAgentGUIDetailEditRetry(input: {
  agentSessionId: string | null;
  workspaceId: string;
}) {
  const controller = useAgentGUIEditRetryController(input);
  const control = useMemo<AgentTranscriptEditRetryControl | undefined>(() => {
    const eligibleTurnId = controller.presentation.editableTurnId?.trim() ?? "";
    if (!eligibleTurnId) {
      return undefined;
    }
    return {
      agentSessionId: input.agentSessionId ?? "",
      eligibleTurnId,
      pending: controller.presentation.state === "processing",
      labels: {
        edit: translate("agentHost.agentGui.editRetryEditMessage"),
        cancel: translate("agentHost.agentGui.editRetryCancel"),
        submit: translate("agentHost.agentGui.send")
      },
      onSubmit: controller.submit
    };
  }, [
    controller.presentation.editableTurnId,
    controller.presentation.state,
    controller.submit,
    input.agentSessionId
  ]);

  return {
    control,
    presentation: controller.presentation,
    recover: controller.recover
  };
}
