export interface TuttiProtectedDeletionIssue {
  executionId: string;
  issueId: string;
  sourceSessionId: string;
  status: string;
}

export interface TuttiProtectedDeletionConflict {
  protectedIssues: readonly TuttiProtectedDeletionIssue[];
}

export function parseTuttiProtectedDeletionConflict(
  error: unknown
): TuttiProtectedDeletionConflict | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const candidate = error as {
    code?: unknown;
    reason?: unknown;
    details?: { protectedIssues?: unknown };
  };
  if (
    candidate.code !== "workspace_issue_resource_exists" ||
    candidate.reason !== "tutti_execution_active" ||
    !Array.isArray(candidate.details?.protectedIssues)
  ) {
    return null;
  }
  const protectedIssues = candidate.details.protectedIssues.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const value = item as Record<string, unknown>;
    return typeof value.issueId === "string" &&
      typeof value.executionId === "string" &&
      typeof value.sourceSessionId === "string" &&
      typeof value.status === "string"
      ? [
          {
            executionId: value.executionId,
            issueId: value.issueId,
            sourceSessionId: value.sourceSessionId,
            status: value.status
          }
        ]
      : [];
  });
  return protectedIssues.length > 0 ? { protectedIssues } : null;
}
