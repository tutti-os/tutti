import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";

export type RuntimeTurn = {
  readonly turnId: string;
  readonly promptUuid: string;
  readonly synthetic?: boolean;
  settled: boolean;
};

type TerminalEvent = "turn_completed" | "turn_canceled" | "turn_failed";

export class TurnLifecycle {
  private readonly turns: RuntimeTurn[] = [];
  private readonly emit: ClaudeSDKSidecarEventEmitter;
  private readonly onActivate: () => void;
  private readonly onSettled: () => void;
  private active: RuntimeTurn | undefined;
  private activeIdValue = "";
  private pendingOrphanCount = 0;
  private cancelledValue = false;
  private completedTurnCount = 0;
  private forceCancelTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: {
    emit: ClaudeSDKSidecarEventEmitter;
    onActivate: () => void;
    onSettled: () => void;
  }) {
    this.emit = options.emit;
    this.onActivate = options.onActivate;
    this.onSettled = options.onSettled;
  }

  get activeId(): string {
    return this.activeIdValue;
  }

  get activeTurn(): RuntimeTurn | undefined {
    return this.active;
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
      return this.active;
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
    this.clearForceCancelTimer();
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

  scheduleForceCancel(callback: () => void, graceMs: number): void {
    if (!this.active || this.forceCancelTimer) {
      return;
    }
    this.forceCancelTimer = setTimeout(callback, graceMs);
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
    this.clearForceCancelTimer();
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
    if (turn.synthetic) {
      this.emit({
        type: "turn_started",
        payload: { turnId: turn.turnId, synthetic: true }
      });
    }
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

  private clearForceCancelTimer(): void {
    if (!this.forceCancelTimer) {
      return;
    }
    clearTimeout(this.forceCancelTimer);
    this.forceCancelTimer = undefined;
  }
}
