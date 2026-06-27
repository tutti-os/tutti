import type { IssueManagerStatus } from "../../../contracts/index.ts";

export type IssueManagerMentionStatusTone =
  | "amber"
  | "blue"
  | "green"
  | "neutral"
  | "purple"
  | "red";

export type IssueManagerStatusBadgeVariant =
  | "accent"
  | "default"
  | "destructive"
  | "muted"
  | "pending"
  | "success"
  | "warning";

export interface IssueManagerStatusPresentation {
  badgeVariant: IssueManagerStatusBadgeVariant;
  dataStatus: string;
  mentionTone: IssueManagerMentionStatusTone;
}

export function resolveIssueManagerStatusPresentation(
  status: IssueManagerStatus | null | undefined
): IssueManagerStatusPresentation {
  const dataStatus =
    String(status ?? "")
      .trim()
      .toLowerCase() || "not_started";
  switch (dataStatus) {
    case "running":
      return { badgeVariant: "accent", dataStatus, mentionTone: "blue" };
    case "pending_acceptance":
      return { badgeVariant: "pending", dataStatus, mentionTone: "purple" };
    case "completed":
      return { badgeVariant: "success", dataStatus, mentionTone: "green" };
    case "failed":
      return { badgeVariant: "destructive", dataStatus, mentionTone: "red" };
    case "canceled":
      return { badgeVariant: "muted", dataStatus, mentionTone: "neutral" };
    default:
      return { badgeVariant: "default", dataStatus, mentionTone: "neutral" };
  }
}
