import type { JSX } from "react";
import {
  Badge,
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import type { IssueManagerController } from "../../react/index.ts";

export function ManagedTuttiIssueActions({
  controller
}: {
  controller: IssueManagerController;
}): JSX.Element | null {
  if (!controller.isTuttiModePlanIssue) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary">
            {controller.copy.t("labels.managedReadOnly")}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {controller.copy.t("messages.managedReadOnlyTooltip")}
        </TooltipContent>
      </Tooltip>
      <Button
        type="button"
        variant="secondary"
        onClick={() => void controller.modifyManagedInMainConversation()}
      >
        {controller.copy.t("actions.modifyInMainConversation")}
      </Button>
    </div>
  );
}
