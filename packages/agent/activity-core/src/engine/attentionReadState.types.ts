export type AttentionCompletionKind = "completed" | "failed";
export type AttentionObservationProvenance = "historical" | "live";
export type AttentionReadStateProvenance = "durable" | "historical" | "live";

export interface AttentionReadRecord {
  completionKey: string;
  /** Compatibility projection: every stored attention record is unread. */
  isUnread: boolean;
  kind: AttentionCompletionKind;
  markedUnreadByUser: boolean;
  /** Whether this completion has live/manual rather than historical provenance. */
  observationProvenance: AttentionObservationProvenance;
  /**
   * Compatibility projection. Historical reads no longer create records, so
   * this field no longer participates in read/unread decisions.
   */
  readStateProvenance?: AttentionReadStateProvenance;
}

export interface AttentionReadPartition {
  lastError: string | null;
  recordsBySessionId: Readonly<Record<string, AttentionReadRecord>>;
  workspaceId: string | null;
  writeDirty: boolean;
  writeInFlightCommandId: string | null;
  writeRevision: number;
  // Durable unread state, keyed by completion key
  // (`turn:<session>:<turn>:<kind>`) rather than bare session id. Only live
  // completions and user unread requests create entries; read removes the
  // entry. The legacy `readIds` fields remain in the serialized schema for
  // backward compatibility, but are ignored on hydration and cleared on the
  // next successful write.
  hydrated: {
    completedReadIds: readonly string[];
    completedUnreadIds: readonly string[];
    failedReadIds: readonly string[];
    failedUnreadIds: readonly string[];
  } | null;
}
export interface AttentionReadState {
  partitionsByUserId: Readonly<Record<string, AttentionReadPartition>>;
}

export type AttentionReadIntent =
  | {
      type: "attention/hydrateRequested";
      commandId: string;
      userId: string;
      workspaceId: string;
    }
  | {
      type: "attention/read";
      userId: string;
      agentSessionId: string;
    }
  | {
      type: "attention/unreadRequested";
      userId: string;
      agentSessionId: string;
    }
  | {
      type: "attention/persistRetryRequested";
      userId: string;
    }
  | {
      type: "attention/readStateHydrated";
      userId: string;
      completed: { readIds: readonly string[]; unreadIds: readonly string[] };
      failed: { readIds: readonly string[]; unreadIds: readonly string[] };
    };

export interface AttentionReadStateReadCommand {
  type: "attention/readState/read";
  commandId: string;
  correlationId: string;
  userId: string;
  workspaceId: string;
}

export interface AttentionReadStateWriteCommand {
  type: "attention/readState/write";
  commandId: string;
  correlationId: string;
  userId: string;
  workspaceId: string;
  completed: { readIds: readonly string[]; unreadIds: readonly string[] };
  failed: { readIds: readonly string[]; unreadIds: readonly string[] };
}

export type AttentionReadCommand =
  | AttentionReadStateReadCommand
  | AttentionReadStateWriteCommand;
