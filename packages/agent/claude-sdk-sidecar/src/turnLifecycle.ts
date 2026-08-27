import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";
import type { ProviderTurnIdentityBindingDisposition } from "./providerTurnAcceptance.ts";

export type RuntimeTurn = {
  readonly turnId: string;
  /**
   * Correlates the outbound SDK prompt with mocks and SDK versions that
   * preserve caller UUIDs. Claude Code may rewrite it before persistence, so
   * it is not provider identity.
   */
  readonly promptUuid: string;
  awaitingProviderTurnIdentity?: boolean;
  providerTurnId?: string;
  providerTurnStarted?: boolean;
  readonly synthetic?: boolean;
  awaitingContinuation?: boolean;
  readonly origin?: string;
  readonly goalOperationId?: string;
  readonly goalRevision?: number;
  readonly goalRepairEpoch?: number;
  readonly goalAction?: "set" | "clear";
  canceling?: boolean;
  settled: boolean;
};

type TerminalEvent = "turn_completed" | "turn_canceled" | "turn_failed";

export type ExactTurnCancellationPreparation = {
  disposition: "active" | "queued" | "absent" | "mismatch" | "unresolved";
  providerTurnId: string;
  differentActiveTurn?: boolean;
};

function turnProvenancePayload(
  turn: RuntimeTurn
): Record<string, string | number> {
  return {
    ...(turn.origin ? { turnOrigin: turn.origin } : {}),
    ...(turn.goalOperationId
      ? { sourceGoalOperationId: turn.goalOperationId }
      : {}),
    ...(turn.goalRevision ? { sourceGoalRevision: turn.goalRevision } : {}),
    ...(turn.goalRepairEpoch
      ? { sourceGoalRepairEpoch: turn.goalRepairEpoch }
      : {})
  };
}

export class TurnLifecycle {
  private readonly turns: RuntimeTurn[] = [];
  private readonly emit: ClaudeSDKSidecarEventEmitter;
  private readonly onActivate: () => void;
  private readonly onSyntheticActivate: (turnId: string) => void;
  private readonly onProviderTurnIdentityBound: (turnId: string) => void;
  private readonly onSettled: (turnId: string) => void;
  private readonly onContinuationStartTimeout: () => void;
  private readonly continuationStartTimeoutMs: number;
  private active: RuntimeTurn | undefined;
  private activeIdValue = "";
  private lastTurnIdValue = "";
  private lastProviderTurnIdValue = "";
  private pendingOrphanCount = 0;
  private cancelledValue = false;
  private completedTurnCount = 0;
  private continuationStartTimer: ReturnType<typeof setTimeout> | undefined;
  private rejectingTimedOutContinuation = false;

  constructor(options: {
    emit: ClaudeSDKSidecarEventEmitter;
    onActivate: () => void;
    onSyntheticActivate?: (turnId: string) => void;
    onProviderTurnIdentityBound?: (turnId: string) => void;
    onSettled: (turnId: string) => void;
    onContinuationStartTimeout?: () => void;
    continuationStartTimeoutMs?: number;
  }) {
    this.emit = options.emit;
    this.onActivate = options.onActivate;
    this.onSyntheticActivate = options.onSyntheticActivate ?? (() => {});
    this.onProviderTurnIdentityBound =
      options.onProviderTurnIdentityBound ?? (() => {});
    this.onSettled = options.onSettled;
    this.onContinuationStartTimeout =
      options.onContinuationStartTimeout ?? (() => {});
    this.continuationStartTimeoutMs =
      options.continuationStartTimeoutMs ?? 30_000;
  }

  get activeId(): string {
    return this.activeIdValue;
  }

  /**
   * The most recent turn id, kept after the turn settles. Lets late background
   * task events (which often arrive after the provider turn ended) attribute
   * to the turn that launched them instead of being dropped.
   */
  get lastTurnId(): string {
    return this.activeIdValue || this.lastTurnIdValue;
  }

  get lastProviderTurnId(): string {
    return this.active
      ? this.providerTurnId(this.active)
      : this.lastProviderTurnIdValue;
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

  expectProviderTurnIdentity(turnId: string): void {
    const turn = this.turns.find(
      (candidate) =>
        !candidate.settled &&
        !candidate.canceling &&
        candidate.turnId === turnId.trim()
    );
    if (turn && !turn.synthetic && !turn.providerTurnId?.trim()) {
      turn.awaitingProviderTurnIdentity = true;
    }
  }

  confirmProviderTurnStarted(providerTurnId: string): void {
    const normalizedProviderTurnId = providerTurnId.trim();
    const turn = this.active;
    if (
      !turn ||
      turn.settled ||
      turn.canceling ||
      turn.synthetic ||
      turn.providerTurnStarted ||
      !normalizedProviderTurnId
    ) {
      return;
    }
    this.bindProviderTurnId(turn, normalizedProviderTurnId);
  }

  activateForUserMessage(promptUuid: string): void {
    const normalizedPromptUuid = promptUuid.trim();
    if (!normalizedPromptUuid) {
      this.ensureActive("user");
      return;
    }
    const matched = this.turns.find(
      (turn) =>
        !turn.settled &&
        !turn.canceling &&
        turn.promptUuid === normalizedPromptUuid
    );
    const candidate =
      matched ??
      this.turns.find(
        (turn) =>
          !turn.settled &&
          !turn.canceling &&
          !turn.synthetic &&
          turn.awaitingProviderTurnIdentity === true
      );
    if (candidate) {
      if (!candidate.synthetic) {
        this.rejectingTimedOutContinuation = false;
      }
      this.bindProviderTurnId(candidate, normalizedPromptUuid);
      this.activate(candidate);
      return;
    }
    this.ensureActive("user");
  }

  bindProviderTurnIdentity(
    turnId: string,
    providerTurnId: string
  ): ProviderTurnIdentityBindingDisposition {
    const normalizedTurnId = turnId.trim();
    const turn = this.turns.find(
      (candidate) =>
        !candidate.settled &&
        !candidate.canceling &&
        candidate.turnId === normalizedTurnId
    );
    if (!turn) {
      return "missing";
    }
    const normalizedProviderTurnId = providerTurnId.trim();
    const existingProviderTurnId = turn.providerTurnId?.trim() ?? "";
    if (existingProviderTurnId) {
      return existingProviderTurnId === normalizedProviderTurnId
        ? "already_bound"
        : "conflict";
    }
    return this.bindProviderTurnId(turn, normalizedProviderTurnId)
      ? "bound"
      : "conflict";
  }

  ensureActive(messageType: string): RuntimeTurn | undefined {
    if (this.active && !this.active.settled && !this.active.canceling) {
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
    if (this.active?.canceling) {
      return undefined;
    }
    const turn = this.turns.find(
      (candidate) => !candidate.settled && !candidate.canceling
    );
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
    this.onSyntheticActivate(turn.turnId);
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
      this.emit({
        type: "continuation_delayed",
        payload: {
          turnId: turn.turnId,
          waitedMs: this.continuationStartTimeoutMs
        }
      });
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
    this.emit({
      type,
      payload: {
        ...payload,
        turnId: turn.turnId,
        ...(this.providerTurnId(turn)
          ? { providerTurnId: this.providerTurnId(turn) }
          : {})
      }
    });
    this.clearContinuationStartTimer();
    this.active = undefined;
    this.activeIdValue = "";
    this.compactQueue();
    this.onSettled(turn.turnId);
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

  prepareExactCancellation(turnId: string): ExactTurnCancellationPreparation {
    const expected = turnId.trim();
    if (!expected) {
      return { disposition: "absent", providerTurnId: "" };
    }
    if (this.active && !this.active.settled) {
      if (this.active.turnId !== expected) {
        const queued = this.turns.find(
          (turn) =>
            turn !== this.active && !turn.settled && turn.turnId === expected
        );
        if (!queued) {
          return { disposition: "mismatch", providerTurnId: "" };
        }
        if (queued.canceling) {
          return {
            disposition: "unresolved",
            providerTurnId: this.providerTurnId(queued),
            differentActiveTurn: true
          };
        }
        queued.canceling = true;
        return {
          disposition: "queued",
          providerTurnId: this.providerTurnId(queued),
          differentActiveTurn: true
        };
      }
      if (this.active.canceling) {
        return {
          disposition: "unresolved",
          providerTurnId: this.providerTurnId(this.active)
        };
      }
      this.cancelledValue = true;
      this.active.canceling = true;
      return {
        disposition: "active",
        providerTurnId: this.providerTurnId(this.active)
      };
    }

    const queued = this.turns.find(
      (turn) => !turn.settled && turn.turnId === expected
    );
    if (!queued) {
      return {
        disposition: this.turns.some((turn) => !turn.settled)
          ? "mismatch"
          : "absent",
        providerTurnId: ""
      };
    }
    if (queued.canceling) {
      return {
        disposition: "unresolved",
        providerTurnId: this.providerTurnId(queued)
      };
    }

    queued.canceling = true;
    return {
      disposition: "queued",
      providerTurnId: this.providerTurnId(queued)
    };
  }

  commitExactCancellation(turnId: string): boolean {
    const expected = turnId.trim();
    if (!expected) {
      return false;
    }
    if (
      this.active?.turnId === expected &&
      !this.active.settled &&
      this.active.canceling
    ) {
      this.settleActive("turn_canceled");
      return true;
    }
    const queued = this.turns.find(
      (turn) => !turn.settled && turn.canceling && turn.turnId === expected
    );
    if (!queued) {
      return false;
    }
    if (!this.isUnstartedGoalCommand(queued)) {
      this.completedTurnCount += 1;
    }
    this.settleQueuedTurn(queued, "turn_canceled");
    this.compactQueue();
    this.onSettled(queued.turnId);
    return true;
  }

  prepareGenerationCancellation(): string[] {
    const turnIds: string[] = [];
    for (const turn of this.turns) {
      if (turn.settled) {
        continue;
      }
      turn.canceling = true;
      turnIds.push(turn.turnId);
    }
    return turnIds;
  }

  releaseExactCancellation(turnId: string): void {
    const expected = turnId.trim();
    const turn = this.turns.find(
      (candidate) =>
        !candidate.settled &&
        candidate.canceling &&
        candidate.turnId === expected
    );
    if (turn) {
      turn.canceling = false;
    }
  }

  discardExactAbsent(turnId: string): boolean {
    const expected = turnId.trim();
    const turn = this.turns.find(
      (candidate) => !candidate.settled && candidate.turnId === expected
    );
    if (!turn) {
      return false;
    }
    turn.settled = true;
    if (this.active === turn) {
      this.clearContinuationStartTimer();
      this.active = undefined;
      this.activeIdValue = "";
    }
    this.compactQueue();
    this.onSettled(turn.turnId);
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
    this.lastTurnIdValue = turn.turnId;
    this.lastProviderTurnIdValue = this.providerTurnId(turn);
    this.cancelledValue = false;
    this.pendingOrphanCount = 0;
    this.onActivate();
    if (turn.goalOperationId && turn.goalRevision && turn.goalAction) {
      this.emit({
        type: "goal_command_started",
        payload: {
          turnId: turn.turnId,
          ...(this.providerTurnId(turn)
            ? { providerTurnId: this.providerTurnId(turn) }
            : {}),
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
          ...turnProvenancePayload(turn)
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
    if (type === "turn_canceled" && this.isUnstartedGoalCommand(turn)) {
      this.emit({
        type: "goal_command_canceled",
        payload: {
          turnId: turn.turnId,
          operationId: turn.goalOperationId,
          revision: turn.goalRevision,
          repairEpoch: turn.goalRepairEpoch ?? 0,
          action: turn.goalAction,
          reason: "cancel_requested"
        }
      });
      return;
    }
    this.emit({
      type,
      payload: {
        ...payload,
        turnId: turn.turnId,
        ...(this.providerTurnId(turn)
          ? { providerTurnId: this.providerTurnId(turn) }
          : {})
      }
    });
  }

  private isUnstartedGoalCommand(turn: RuntimeTurn): boolean {
    return Boolean(
      turn.goalOperationId &&
      turn.goalRevision &&
      turn.goalAction &&
      !turn.providerTurnStarted
    );
  }

  private bindProviderTurnId(
    turn: RuntimeTurn,
    providerTurnId: string
  ): boolean {
    if (
      turn.synthetic ||
      !providerTurnId ||
      turn.providerTurnId?.trim() ||
      turn.providerTurnStarted
    ) {
      return false;
    }
    turn.providerTurnId = providerTurnId;
    if (turn === this.active || turn.turnId === this.lastTurnIdValue) {
      this.lastProviderTurnIdValue = providerTurnId;
    }
    turn.awaitingProviderTurnIdentity = false;
    turn.providerTurnStarted = true;
    this.onProviderTurnIdentityBound(turn.turnId);
    this.emit({
      type: "provider_turn_identity_resolved",
      payload: {
        turnId: turn.turnId,
        providerTurnId,
        ...turnProvenancePayload(turn)
      }
    });
    return true;
  }

  private providerTurnId(turn: RuntimeTurn): string {
    return turn.providerTurnId?.trim() || "";
  }

  private compactQueue(): void {
    while (this.turns[0]?.settled) {
      this.turns.shift();
    }
  }
}
