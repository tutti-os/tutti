import type { AgentActivitySession } from "../types.ts";

export type SessionMutationStatus =
  | "inFlight"
  | "succeeded"
  | "failed"
  | "unknown";

export interface SessionDeleteMutationResult {
  cleanupFailedSessionIds: readonly string[];
  removedMessages: number;
  removedSessionIds: readonly string[];
  removedSessions: number;
}

export type SessionMutationRecord =
  | {
      agentSessionIds: readonly string[];
      commandId: string;
      deleteResult: SessionDeleteMutationResult | null;
      errorCode: string | null;
      errorMessage: string | null;
      kind: "delete";
      mutationId: string;
      status: SessionMutationStatus;
      workspaceId: string;
    }
  | {
      agentSessionIds: readonly [string];
      commandId: string;
      errorCode: string | null;
      errorMessage: string | null;
      kind: "pin";
      mutationId: string;
      pinned: boolean;
      status: SessionMutationStatus;
      workspaceId: string;
    };

export interface SessionMutationsState {
  byMutationId: Readonly<Record<string, SessionMutationRecord>>;
}

export interface SessionPinRequestedIntent {
  type: "session/pinRequested";
  agentSessionId: string;
  mutationId: string;
  pinned: boolean;
  timeoutMs?: number;
  workspaceId: string;
}

export interface SessionsDeleteRequestedIntent {
  type: "sessions/deleteRequested";
  agentSessionIds: readonly string[];
  mutationId: string;
  timeoutMs?: number;
  workspaceId: string;
}

export type SessionMutationsIntent =
  | SessionPinRequestedIntent
  | SessionsDeleteRequestedIntent;

export interface SessionSetPinnedCommand {
  type: "session/setPinned";
  agentSessionId: string;
  commandId: string;
  correlationId: string;
  pinned: boolean;
  timeoutMs?: number;
  workspaceId: string;
}

export interface SessionsDeleteCommand {
  type: "sessions/delete";
  agentSessionIds: readonly string[];
  commandId: string;
  correlationId: string;
  timeoutMs?: number;
  workspaceId: string;
}

export type SessionMutationCommand =
  | SessionSetPinnedCommand
  | SessionsDeleteCommand;

export interface SessionPinCommandResult {
  session: AgentActivitySession;
}
