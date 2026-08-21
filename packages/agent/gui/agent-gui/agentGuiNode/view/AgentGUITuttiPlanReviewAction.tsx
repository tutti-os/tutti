import { Button } from "@tutti-os/ui-system";

interface AgentGUITuttiPlanReviewActionSlotController {
  planReviewDraftHasContent: boolean;
  planReviewPreferencesDiverged: boolean;
  planReviewSendActive: boolean;
  requestPendingPlanChanges(): void;
}

export function AgentGUITuttiPlanReviewActionSlot({
  controller,
  label
}: {
  controller: AgentGUITuttiPlanReviewActionSlotController;
  label: string;
}): React.JSX.Element | null {
  if (
    !controller.planReviewSendActive ||
    !controller.planReviewPreferencesDiverged ||
    controller.planReviewDraftHasContent
  ) {
    return null;
  }
  return (
    <AgentGUITuttiPlanReviewAction
      label={label}
      onRequestChanges={controller.requestPendingPlanChanges}
    />
  );
}

export function AgentGUITuttiPlanReviewAction({
  label,
  onRequestChanges
}: {
  label: string;
  onRequestChanges(): void;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="rounded-full"
      data-testid="agent-gui-plan-request-changes"
      onClick={onRequestChanges}
    >
      {label}
    </Button>
  );
}
