export type AttentionCompletionKind = "completed" | "failed";

export interface AttentionReadRecord {
  completionKey: string;
  isUnread: boolean;
  kind: AttentionCompletionKind;
}

export interface AttentionReadPartition {
  lastError: string | null;
  recordsBySessionId: Readonly<Record<string, AttentionReadRecord>>;
  workspaceId: string | null;
  writeDirty: boolean;
  writeInFlightCommandId: string | null;
  writeRevision: number;
  // Durable read state, keyed by completion key (`turn:<session>:<turn>:<kind>`)
  // rather than bare session id, so a new turn on an already-read session is a
  // distinct entry and re-lights the lamp. Kept bounded to the latest completion
  // per session. The `*Ids` naming is retained only because it is the serialized
  // persistence field name; the values are completion keys, not session ids.
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
