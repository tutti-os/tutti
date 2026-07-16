import type {
  AgentActivityComposerOptions,
  AgentActivityComposerOptionsLoadStatus,
  AgentActivityComposerSettings
} from "../types.ts";

/**
 * Per-target load bookkeeping. Replaces the former imperative cache
 * coordinator: `loadingSignature` deduplicates in-flight loads, `settledSignature`
 * decides whether a cached result still satisfies a request, and
 * `inFlightCommandId` guards against a superseded load settling late.
 *
 * Retry bookkeeping: a non-4xx failure keeps the entry loading and schedules
 * a bounded backoff retry (`retryPending` + `retryCount`), re-issuing the load
 * from the stored `request` snapshot when the expiry fires. 4xx failures and
 * an exhausted budget settle into a terminal "error" the presentation layer
 * renders as a recoverable error state.
 */
export interface ComposerOptionsEntry {
  status: AgentActivityComposerOptionsLoadStatus;
  provider: string;
  loadingSignature: string | null;
  settledSignature: string | null;
  loadVersion: number;
  inFlightCommandId: string | null;
  retryCount: number;
  retryPending: boolean;
  request: ComposerOptionsRequestSnapshot | null;
}

export interface ComposerOptionsRequestSnapshot {
  workspaceId: string;
  cwd?: string | null;
  settings?: AgentActivityComposerSettings | null;
}

export interface ComposerOptionsState {
  optionsByTargetKey: Readonly<Record<string, AgentActivityComposerOptions>>;
  entriesByTargetKey: Readonly<Record<string, ComposerOptionsEntry>>;
}

export interface ComposerOptionsLoadRequestedIntent {
  type: "composerOptions/loadRequested";
  commandId: string;
  targetKey: string;
  provider: string;
  workspaceId: string;
  cwd?: string | null;
  settings?: AgentActivityComposerSettings | null;
  force?: boolean;
}

export interface ComposerOptionsInvalidatedIntent {
  type: "composerOptions/invalidated";
  providers?: readonly string[];
  /** Exact opaque target keys; combined with provider filters when both exist. */
  targetKeys?: readonly string[];
}

export type ComposerOptionsIntent =
  | ComposerOptionsLoadRequestedIntent
  | ComposerOptionsInvalidatedIntent;

export interface ComposerOptionsLoadCommand {
  type: "composerOptions/load";
  commandId: string;
  correlationId: string;
  targetKey: string;
  provider: string;
  workspaceId: string;
  cwd?: string | null;
  settings?: AgentActivityComposerSettings | null;
}

export type ComposerOptionsCommand = ComposerOptionsLoadCommand;
