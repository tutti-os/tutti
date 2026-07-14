import type { WorkbenchFrame } from "@tutti-os/workbench-surface";

export const defaultIssueManagerWorkbenchTypeId = "issue-manager";

/**
 * Optional workbench node-data flag: hosts that embed the issue manager
 * without its window header set this to "sidebar" so the topic selector
 * renders inside the task-list sidebar instead.
 */
export const issueManagerTopicSelectorPlacementDataKey =
  "issueManagerTopicSelectorPlacement";

export const defaultIssueManagerNodeFrame: WorkbenchFrame = {
  height: 560,
  width: 860,
  x: 220,
  y: 120
};
