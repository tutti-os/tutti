import type { IssueManagerStatus } from "../../../contracts/index.ts";

export type IssueManagerStatusBadgeVariant =
  | "accent"
  | "default"
  | "destructive"
  | "muted"
  | "pending"
  | "success"
  | "warning";

export function issueManagerStatusBadgeVariant(
  status: IssueManagerStatus
): IssueManagerStatusBadgeVariant {
  switch (status) {
    case "running":
      return "accent";
    case "pending_acceptance":
      return "pending";
    case "completed":
      return "success";
    case "failed":
      return "destructive";
    case "canceled":
      return "muted";
    default:
      return "default";
  }
}
