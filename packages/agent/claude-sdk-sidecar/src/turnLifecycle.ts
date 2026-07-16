import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";

export type RuntimeTurn = {
  readonly turnId: string;
  readonly promptUuid: string;
  readonly synthetic?: boolean;
  awaitingContinuation?: boolean;
  readonly origin?: string;
  readonly goalOperationId?: string;
  readonly goalRevision?: number;
  readonly goalRepairEpoch?: number;
  readonly goalAction?: "set" | "clear";
  settled: boolean;
};

type TerminalEvent = "turn_completed" | "turn_canceled" | "turn_failed";

export class TurnLifecycle {
  private readonly turns: RuntimeTurn[] = [];
  private readonly emit: ClaudeSDKSidecarEventEmitter;
  private readonly onActivate: () => void;
  private readonly onSettled: () => void;
  private readonly onContinuationStartTimeout: () => void;
  private readonly continuationStartTimeoutMs: number;
  private active: RuntimeTurn | undefined;
  private activeIdValue = "";
  private pendingOrphanCount = 0;
  private cancelledValue = false;
  private completedTurnCount = 0;
  private continuationStartTimer: ReturnType<typeof setTimeout> | undefined;
  private rejectingTimedOutContinuation = false;

  constructor(options: {
    emit: ClaudeSDKSidecarEventEmitter;
    onActivate: () => void;
    onSettled: () => void;
    onContinuationStartTimeout?: () => void;
    continuationStartTimeoutMs?: number;
  }) {
    this.emit = options.emit;
    this.onActivate = options.onActivate;
    this.onSettled = options.onSettled;
    this.onContinuationStartTimeout =
      options.onContinuationStartTimeout ?? (() => {});
    this.continuationStartTimeoutMs =
      options.continuationStartTimeoutMs ?? 30_000;
  }

  get activeId(): string {
    return this.activeIdValue;
  }

  get activeTurn(): RuntimeTurn | undefined {
    return this.active;
  }

  get awaitingContinuation(): boolean {
    return this.active?.awaitingContinuation === true;
  }

  get queue(): readonly RuntimeTurn[] {
    return this.turns;
  }

  get cancelled(): boolean {
    return this.cancelledValue;
  }

  get turnCount(): number {
    return this.completedTurnCount;
  }

  get pendingOrphans(): number {
    return this.pendingOrphanCount;
  }

  restoreTurnCount(value: number): void {
    this.completedTurnCount = value;
  }

  activateTransient(turnId: string): void {
    this.activeIdValue = turnId;
    this.onActivate();
  }

  enqueue(turn: RuntimeTurn): void {
    this.turns.push(turn);
  }

  activateForPromptUuid(promptUuid: string): void {
    if (!promptUuid) {
      return;
    }
    const matched = this.turns.find(
      (turn) => !turn.settled && turn.promptUuid === promptUuid
    );
    if (matched) {
      if (!matched.synthetic) {
        this.rejectingTimedOutContinuation = false;
      }
      this.activate(matched);
    }
  }

  activateForUserMessage(promptUuid: string): void {
    this.activateForPromptUuid(promptUuid);
    if (!this.active) {
      this.ensureActive("user");
    }
  }

  ensureActive(messageType: string): RuntimeTurn | undefined {
    if (this.active && !this.active.settled) {
      if (messageType === "assistant" || messageType === "stream_event") {
        this.confirmContinuationStarted();
      }
      return this.active;
    }
    if (this.rejectingTimedOutContinuation && messageType !== "user") {
      return undefined;
    }
    if (messageType !== "user" && this.pendingOrphanCount > 0) {
      return undefined;
    }
    const turn = this.turns.find((candidate) => !candidate.settled);
    if (!turn) {
      return messageType === "assistant" ? this.activateSynthetic() : undefined;
    }
    this.activate(turn);
    return turn;
  }

  activateSynthetic(): RuntimeTurn {
    const turn: RuntimeTurn = {
      turnId: `synthetic-${crypto.randomUUID()}`,
      promptUuid: "",
      synthetic: true,
      settled: false
    };
    this.turns.push(turn);
    this.activate(turn);
    return turn;
  }

  expectSyntheticContinuation(): RuntimeTurn | undefined {
    if (this.active && !this.active.settled) {
      return this.active;
    }
    if (this.rejectingTimedOutContinuation) {
      return undefined;
    }
    const turn = this.activateSynthetic();
    turn.awaitingContinuation = true;
    this.continuationStartTimer = setTimeout(() => {
      if (this.active !== turn || turn.settled || !turn.awaitingContinuation) {
        return;
      }
      turn.awaitingContinuation = false;
      this.rejectingTimedOutContinuation = true;
      this.settleActive("turn_completed", {
        stopReason: "background_agent_continuation_timeout",
        syntheticTimeout: true
      });
      this.onContinuationStartTimeout();
    }, this.continuationStartTimeoutMs);
    (
      this.continuationStartTimer as ReturnType<typeof setTimeout> & {
        unref?: () => void;
      }
    ).unref?.();
    return turn;
  }

  consumeTimedOutContinuationResult(): boolean {
    if (!this.rejectingTimedOutContinuation) {
      return false;
    }
    this.rejectingTimedOutContinuation = false;
    return true;
  }

  closeSyntheticBeforeUserTurn(): void {
    if (!this.active?.synthetic || this.active.settled) {
      return;
    }
    this.settleActive("turn_completed", { stopReason: "background_agent" });
  }

  settleActive(
    type: TerminalEvent,
    payload: Record<string, unknown> = {}
  ): void {
    const turn = this.active;
    if (!turn || turn.settled) {
      return;
    }
    turn.settled = true;
    this.completedTurnCount += 1;
    this.emit({ type, payload: { ...payload, turnId: turn.turnId } });
    this.clearContinuationStartTimer();
    this.active = undefined;
    this.activeIdValue = "";
    this.compactQueue();
    this.onSettled();
  }

  failLiveTurns(error: string): void {
    if (this.active) {
      this.settleActive(this.cancelledValue ? "turn_canceled" : "turn_failed", {
        error
      });
    }
    this.failQueuedTurns(error);
  }

  failQueuedTurns(error: string): void {
    for (const turn of this.turns) {
      if (turn.settled || turn === this.active) {
        continue;
      }
      this.settleQueuedTurn(
        turn,
        this.cancelledValue ? "turn_canceled" : "turn_failed",
        { error }
      );
    }
    this.compactQueue();
  }

  cancelQueued(): boolean {
    this.cancelledValue = true;
    this.clearContinuationStartTimer();
    if (this.active) {
      this.active.awaitingContinuation = false;
    }
    let orphaned = 0;
    for (const turn of this.turns) {
      if (turn.settled || turn === this.active) {
        continue;
      }
      this.settleQueuedTurn(turn, "turn_canceled");
      orphaned += 1;
    }
    this.pendingOrphanCount += orphaned;
    this.compactQueue();
    return Boolean(this.active);
  }

  cancelActiveExact(turnId: string): boolean {
    const expected = turnId.trim();
    if (!expected || this.active?.turnId !== expected || this.active.settled) {
      return false;
    }
    this.cancelledValue = true;
    return true;
  }
  clearCancelled(): void {
    this.cancelledValue = false;
  }

  clearPendingOrphans(): void {
    this.pendingOrphanCount = 0;
  }

  consumePendingOrphan(): boolean {
    if (this.pendingOrphanCount <= 0) {
      return false;
    }
    this.pendingOrphanCount -= 1;
    return true;
  }

  close(): void {
    this.clearContinuationStartTimer();
  }

  private activate(turn: RuntimeTurn): void {
    if (this.active === turn) {
      return;
    }
    this.active = turn;
    this.activeIdValue = turn.turnId;
    this.cancelledValue = false;
    this.pendingOrphanCount = 0;
    this.onActivate();
    if (turn.goalOperationId && turn.goalRevision && turn.goalAction) {
      this.emit({
        type: "goal_command_started",
        payload: {
          turnId: turn.turnId,
          operationId: turn.goalOperationId,
          revision: turn.goalRevision,
          repairEpoch: turn.goalRepairEpoch ?? 0,
          action: turn.goalAction
        }
      });
    }
    if (turn.synthetic || turn.origin) {
      this.emit({
        type: "turn_started",
        payload: {
          turnId: turn.turnId,
          ...(turn.synthetic ? { synthetic: true } : {}),
          ...(turn.origin ? { turnOrigin: turn.origin } : {}),
          ...(turn.goalOperationId
            ? { sourceGoalOperationId: turn.goalOperationId }
            : {}),
          ...(turn.goalRevision
            ? { sourceGoalRevision: turn.goalRevision }
            : {}),
          ...(turn.goalRepairEpoch
            ? { sourceGoalRepairEpoch: turn.goalRepairEpoch }
            : {})
        }
      });
    }
  }

  private confirmContinuationStarted(): void {
    if (!this.active?.awaitingContinuation) {
      return;
    }
    this.active.awaitingContinuation = false;
    this.clearContinuationStartTimer();
  }

  private clearContinuationStartTimer(): void {
    if (!this.continuationStartTimer) {
      return;
    }
    clearTimeout(this.continuationStartTimer);
    this.continuationStartTimer = undefined;
  }

  private settleQueuedTurn(
    turn: RuntimeTurn,
    type: "turn_canceled" | "turn_failed",
    payload: Record<string, unknown> = {}
  ): void {
    if (turn.settled) {
      return;
    }
    turn.settled = true;
    this.emit({ type, payload: { ...payload, turnId: turn.turnId } });
  }

  private compactQueue(): void {
    while (this.turns[0]?.settled) {
      this.turns.shift();
    }
  }
}
