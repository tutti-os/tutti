import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { numberValue, recordValue } from "./normalizer.ts";
import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";
import { stringValue } from "./runtimeValues.ts";
import type { TranscriptObservationSource } from "./transcriptObservationStore.ts";
import type { TurnLifecycle } from "./turnLifecycle.ts";

type GoalUpdateType = "thread_goal_update" | "thread_goal_completed";

export type GoalTranscriptProjectionSummary = {
  projectedUpdateCount: number;
  projectedTerminalCount: number;
  ignoredDuplicateCount: number;
  ignoredInvalidCount: number;
  ignoredStaleGenerationCount: number;
  ignoredUnboundGenerationCount: number;
  ignoredObjectiveMismatchCount: number;
  ignoredOutsideCurrentTurnCount: number;
};

type GoalGeneration = {
  readonly operationId: string;
  readonly revision: number;
  readonly repairEpoch: number;
  readonly activatedAtUnixMs: number;
  readonly objective: string;
};

/** Projects Claude's durable goal-status records into the sidecar contract. */
export class ClaudeGoalProjection {
  private readonly turns: TurnLifecycle;
  private readonly emit: ClaudeSDKSidecarEventEmitter;
  private readonly projectedEntryIds = new Set<string>();
  private readonly ignoredLiveEntryIds = new Set<string>();
  private currentGeneration: GoalGeneration | undefined;
  private terminalOperationId = "";

  constructor(turns: TurnLifecycle, emit: ClaudeSDKSidecarEventEmitter) {
    this.turns = turns;
    this.emit = emit;
  }

  restoreGeneration(
    identity: Record<string, unknown> | undefined,
    goal: Record<string, unknown> | undefined
  ): void {
    const operationId = stringValue(identity?.operationId);
    const revision = numberValue(identity?.revision);
    const repairEpoch = numberValue(identity?.repairEpoch);
    const activatedAtUnixMs = numberValue(identity?.activatedAtUnixMs);
    const objective = stringValue(goal?.objective);
    if (
      !operationId ||
      !Number.isInteger(revision) ||
      revision <= 0 ||
      !Number.isInteger(repairEpoch) ||
      repairEpoch < 0 ||
      !Number.isInteger(activatedAtUnixMs) ||
      activatedAtUnixMs <= 0 ||
      !objective ||
      stringValue(goal?.status) !== "active"
    ) {
      return;
    }
    this.currentGeneration = {
      operationId,
      revision,
      repairEpoch,
      activatedAtUnixMs,
      objective
    };
    this.terminalOperationId = "";
  }

  shouldReplayNativeTranscript(): boolean {
    const activeTurn = this.turns.activeTurn;
    if (activeTurn?.goalAction === "clear") {
      return false;
    }
    if (activeTurn?.goalAction === "set") {
      return activeTurn.goalOperationId !== this.terminalOperationId;
    }
    return this.currentGeneration !== undefined;
  }

  settleGoalControl(
    action: "set" | "clear" | undefined,
    succeeded: boolean
  ): void {
    if (action === "clear" && succeeded) {
      this.currentGeneration = undefined;
      this.terminalOperationId = "";
    }
  }

  observeTranscriptEntries(
    entries: readonly SessionStoreEntry[],
    transcriptSource: TranscriptObservationSource = "live_mirror"
  ): GoalTranscriptProjectionSummary {
    const summary = emptyProjectionSummary();
    const activeTurn = this.turns.activeTurn;
    const replayBoundary =
      transcriptSource === "native_replay" && activeTurn?.goalAction === "set"
        ? nativeReplayTurnBoundary(entries, this.turns.lastProviderTurnId)
        : undefined;
    for (const entry of entries) {
      const attachment = recordValue(entry.attachment);
      if (
        stringValue(entry.type) !== "attachment" ||
        stringValue(attachment?.type) !== "goal_status"
      ) {
        continue;
      }
      const entryId = stringValue(entry.uuid);
      if (
        entryId &&
        (this.projectedEntryIds.has(entryId) ||
          (transcriptSource === "live_mirror" &&
            this.ignoredLiveEntryIds.has(entryId)))
      ) {
        summary.ignoredDuplicateCount += 1;
        continue;
      }
      const objective = stringValue(attachment?.condition);
      if (!objective || typeof attachment?.met !== "boolean") {
        summary.ignoredInvalidCount += 1;
        continue;
      }
      const occurredAtUnixMs = transcriptTimestampUnixMs(entry.timestamp);
      if (
        replayBoundary &&
        (!entryId || !replayBoundary.lineageEntryIds.has(entryId))
      ) {
        summary.ignoredOutsideCurrentTurnCount += 1;
        continue;
      }
      if (
        this.currentGeneration?.activatedAtUnixMs &&
        (occurredAtUnixMs === 0 ||
          occurredAtUnixMs < this.currentGeneration.activatedAtUnixMs)
      ) {
        summary.ignoredStaleGenerationCount += 1;
        this.rememberIgnoredLiveEntry(entryId, transcriptSource);
        continue;
      }
      if (attachment.sentinel === true && attachment.met === false) {
        const operationId = activeTurn?.goalOperationId?.trim() ?? "";
        const revision = activeTurn?.goalRevision ?? 0;
        if (
          activeTurn?.goalAction !== "set" ||
          !operationId ||
          !Number.isInteger(revision) ||
          revision <= 0
        ) {
          summary.ignoredUnboundGenerationCount += 1;
          this.rememberIgnoredLiveEntry(entryId, transcriptSource);
          continue;
        }
        if (
          transcriptSource === "native_replay" &&
          (entryId !== replayBoundary?.sentinelEntryId ||
            !activeTurn.goalActivatedAtUnixMs ||
            occurredAtUnixMs === 0 ||
            occurredAtUnixMs < activeTurn.goalActivatedAtUnixMs)
        ) {
          summary.ignoredOutsideCurrentTurnCount += 1;
          continue;
        }
        this.currentGeneration = {
          operationId,
          revision,
          repairEpoch: activeTurn.goalRepairEpoch ?? 0,
          activatedAtUnixMs: occurredAtUnixMs,
          objective
        };
        this.terminalOperationId = "";
      }
      const generation = this.currentGeneration;
      if (!generation || generation.objective !== objective) {
        if (generation) {
          summary.ignoredObjectiveMismatchCount += 1;
        } else {
          summary.ignoredUnboundGenerationCount += 1;
        }
        this.rememberIgnoredLiveEntry(entryId, transcriptSource);
        continue;
      }
      const failed = attachment.failed === true;
      const goal: Record<string, unknown> = {
        objective,
        status: attachment.met ? "complete" : failed ? "blocked" : "active"
      };
      copyNonNegativeInteger(attachment, goal, "iterations");
      copyNonNegativeInteger(attachment, goal, "durationMs");
      copyNonNegativeInteger(attachment, goal, "tokens");
      const reason = stringValue(attachment.reason);
      if (reason) {
        goal.reason = reason;
      }
      if (entryId) {
        // Dedupe only after immutable provenance has bound the record to the
        // current Goal generation. An eager mirror can arrive before the root
        // provider Turn activates; replay must be allowed to reconsider it.
        this.rememberProjectedEntry(entryId);
      }
      if (attachment.met || failed) {
        summary.projectedTerminalCount += 1;
      } else {
        summary.projectedUpdateCount += 1;
      }
      this.emitObservation(
        attachment.met ? "thread_goal_completed" : "thread_goal_update",
        generation,
        goal,
        occurredAtUnixMs
      );
      if (attachment.met || failed) {
        this.terminalOperationId = generation.operationId;
        this.currentGeneration = undefined;
      }
    }
    return summary;
  }

  private rememberProjectedEntry(entryId: string): void {
    rememberBoundedEntry(this.projectedEntryIds, entryId);
  }

  private rememberIgnoredLiveEntry(
    entryId: string,
    source: TranscriptObservationSource
  ): void {
    if (source === "live_mirror" && entryId) {
      rememberBoundedEntry(this.ignoredLiveEntryIds, entryId);
    }
  }

  private emitObservation(
    updateType: GoalUpdateType,
    generation: GoalGeneration,
    goal: Record<string, unknown>,
    occurredAtUnixMs: number
  ): void {
    const activeTurn = this.turns.activeTurn;
    this.emit({
      type: "goal_observed",
      payload: {
        turnId: this.turns.activeId,
        ...(this.turns.lastProviderTurnId
          ? { providerTurnId: this.turns.lastProviderTurnId }
          : {}),
        ...(activeTurn?.goalAction ? { action: activeTurn.goalAction } : {}),
        goalOperationId: generation.operationId,
        goalRevision: generation.revision,
        goalRepairEpoch: generation.repairEpoch,
        ...(occurredAtUnixMs > 0 ? { occurredAtUnixMs } : {}),
        source: "transcript_mirror",
        updateType,
        goal
      }
    });
  }
}

function rememberBoundedEntry(entries: Set<string>, entryId: string): void {
  entries.add(entryId);
  if (entries.size <= 1024) {
    return;
  }
  const oldest = entries.values().next().value;
  if (oldest) {
    entries.delete(oldest);
  }
}

function emptyProjectionSummary(): GoalTranscriptProjectionSummary {
  return {
    projectedUpdateCount: 0,
    projectedTerminalCount: 0,
    ignoredDuplicateCount: 0,
    ignoredInvalidCount: 0,
    ignoredStaleGenerationCount: 0,
    ignoredUnboundGenerationCount: 0,
    ignoredObjectiveMismatchCount: 0,
    ignoredOutsideCurrentTurnCount: 0
  };
}

function nativeReplayTurnBoundary(
  entries: readonly SessionStoreEntry[],
  providerTurnId: string
): { sentinelEntryId: string; lineageEntryIds: ReadonlySet<string> } {
  providerTurnId = providerTurnId.trim();
  // Claude persists the /goal sentinel immediately before the command's root
  // user entry and links that user back to the sentinel through parentUuid.
  // That structural edge is the immutable replay boundary; timestamps only
  // provide an additional fail-closed check.
  const providerUser = entries.find(
    (entry) =>
      stringValue(entry.type) === "user" &&
      stringValue(entry.uuid) === providerTurnId
  );
  const sentinelEntryId = stringValue(providerUser?.parentUuid);
  const lineageEntryIds = new Set<string>();
  if (!providerTurnId || !sentinelEntryId) {
    return { sentinelEntryId: "", lineageEntryIds };
  }
  lineageEntryIds.add(providerTurnId);
  for (const entry of entries) {
    const entryId = stringValue(entry.uuid);
    const parentEntryId = stringValue(entry.parentUuid);
    if (entryId && parentEntryId && lineageEntryIds.has(parentEntryId)) {
      lineageEntryIds.add(entryId);
    }
  }
  // The sentinel itself is admissible, but its other children are sibling
  // branches and must not inherit the current provider Turn's generation.
  lineageEntryIds.add(sentinelEntryId);
  return { sentinelEntryId, lineageEntryIds };
}

function transcriptTimestampUnixMs(value: unknown): number {
  const timestamp = Date.parse(stringValue(value));
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function copyNonNegativeInteger(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string
): void {
  const raw = source[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return;
  }
  const value = numberValue(raw);
  if (Number.isInteger(value) && value >= 0) {
    target[key] = value;
  }
}
