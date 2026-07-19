/**
 * Explicit evidence required before the frontend engine may tombstone a
 * session. Transport absence (HTTP 404) is never deletion evidence.
 */
export type SessionDeletionEvidence =
  | {
      source: "session_deleted_event";
      deletedAtUnixMs?: number;
    }
  | {
      source: "delete_command";
      mutationId: string;
    };

export function isSessionDeletionEvidence(
  value: unknown
): value is SessionDeletionEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as {
    source?: unknown;
    deletedAtUnixMs?: unknown;
    mutationId?: unknown;
  };
  if (evidence.source === "session_deleted_event") {
    return (
      evidence.deletedAtUnixMs === undefined ||
      (typeof evidence.deletedAtUnixMs === "number" &&
        Number.isFinite(evidence.deletedAtUnixMs))
    );
  }
  if (evidence.source === "delete_command") {
    return (
      typeof evidence.mutationId === "string" &&
      evidence.mutationId.trim().length > 0
    );
  }
  return false;
}
