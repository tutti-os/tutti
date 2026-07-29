import { type JSX } from "react";
import { Button, cn } from "@tutti-os/ui-system";
import type { IssueManagerIssueSummary } from "../../../contracts/index.ts";
import {
  IssueManagerBreakdownActionTrigger,
  IssueManagerExecutionDirectoryTrigger,
  IssueManagerRunActionTrigger
} from "../task/IssueManagerRunSections.tsx";
import type { IssueManagerController } from "../../react/index.ts";
import { isIssueManagerRunControlDisabled } from "./IssueManagerTaskDrawerState.ts";

export interface IssueManagerBottomBarProps {
  controller: IssueManagerController;
  isNarrowLayout: boolean;
  selectedIssue: IssueManagerIssueSummary | null;
  visible: boolean;
}

export function IssueManagerBottomBar({
  controller,
  isNarrowLayout,
  selectedIssue,
  visible
}: IssueManagerBottomBarProps): JSX.Element | null {
  const copy = controller.copy;
  if (!visible || !selectedIssue || controller.isTuttiModePlanIssue) {
    return null;
  }
  const runControlsDisabled = isIssueManagerRunControlDisabled({
    selectedIssueStatus: selectedIssue.status,
    selectedTaskStatus: null
  });

  return (
    <div className="border-t border-[var(--border-1)] bg-transparent px-6 py-4 backdrop-blur">
      <div
        className={cn(
          "flex gap-3",
          isNarrowLayout
            ? "flex-wrap items-center justify-end"
            : "items-center justify-end"
        )}
      >
        <IssueManagerExecutionDirectoryTrigger
          className="mr-auto min-w-0 max-w-[240px] justify-start overflow-hidden"
          controller={controller}
          disabled={runControlsDisabled}
        />
        <div className="flex shrink-0 flex-nowrap items-center justify-end gap-3">
          <IssueManagerBreakdownActionTrigger
            controller={controller}
            disabled={!selectedIssue}
            triggerVariant="button"
          />
          <IssueManagerRunActionTrigger
            controller={controller}
            disabled={!selectedIssue || runControlsDisabled}
            triggerVariant="button"
          />
          {controller.canInviteCollaborators ? (
            <Button
              className="px-4"
              disabled={!selectedIssue}
              size="dialog"
              type="button"
              onClick={() => {
                void controller.shareSelection();
              }}
            >
              {copy.t("actions.inviteCollaborator")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
