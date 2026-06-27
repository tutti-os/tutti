import { formatTuttiShortDateTime } from "@tutti-os/ui-system/date-format";
import type {
  IssueManagerFileReference,
  IssueManagerPriority,
  IssueManagerStatus
} from "../../contracts/index.ts";
import type { IssueManagerI18nRuntime } from "../../i18n/issueManagerI18n.ts";

export type IssueManagerEditorMode = "read" | "create" | "edit";

export type IssueManagerReferenceTarget =
  | {
      mode: "attach";
      parentKind: "issue";
    }
  | {
      mode: "attach";
      parentKind: "task";
      taskId: string;
    }
  | {
      mode: "insert";
      parentKind: "issue";
    }
  | {
      mode: "insert";
      parentKind: "task";
      taskId: string;
    };

export function createIssueManagerDate(
  value: number | null | undefined
): Date | null {
  if (!value || !Number.isFinite(value)) {
    return null;
  }

  const normalized = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatIssueManagerTimestamp(
  value: number | null | undefined
): string | null {
  const date = createIssueManagerDate(value);
  return date ? formatTuttiShortDateTime(date) : null;
}

export function formatIssueManagerDate(
  value: number | null | undefined
): string {
  const date = createIssueManagerDate(value);
  return date ? formatTuttiShortDateTime(date) : "";
}

export function resolveIssueManagerStatusLabel(
  copy: IssueManagerI18nRuntime,
  status: IssueManagerStatus | null | undefined
): string {
  switch (status) {
    case "not_started":
      return copy.t("status.notStarted");
    case "running":
      return copy.t("status.running");
    case "pending_acceptance":
      return copy.t("status.pendingAcceptance");
    case "completed":
      return copy.t("status.completed");
    case "failed":
      return copy.t("status.failed");
    case "canceled":
      return copy.t("status.canceled");
    default:
      return copy.t("status.unknown");
  }
}

export function resolveIssueManagerPriorityLabel(
  copy: IssueManagerI18nRuntime,
  priority: IssueManagerPriority | null | undefined
): string {
  switch (priority) {
    case "high":
      return copy.t("priority.high");
    case "low":
      return copy.t("priority.low");
    default:
      return copy.t("priority.medium");
  }
}

export function uniqueIssueManagerFileReferences(
  refs: readonly IssueManagerFileReference[]
): IssueManagerFileReference[] {
  const unique = new Map<string, IssueManagerFileReference>();
  for (const ref of refs) {
    const normalizedPath = ref.path.trim();
    if (!normalizedPath || unique.has(normalizedPath)) {
      continue;
    }
    unique.set(normalizedPath, {
      displayName: ref.displayName?.trim() || undefined,
      kind: ref.kind === "folder" ? "folder" : "file",
      path: normalizedPath
    });
  }
  return [...unique.values()];
}

export function parentDirectoryPath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return null;
  }

  const normalized =
    trimmed.endsWith("/") && trimmed.length > 1
      ? trimmed.slice(0, -1)
      : trimmed;
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index) || "/";
}
