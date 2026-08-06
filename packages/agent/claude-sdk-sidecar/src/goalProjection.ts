import { numberValue, recordValue } from "./normalizer.ts";
import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";
import { stringValue } from "./runtimeValues.ts";
import type { TurnLifecycle } from "./turnLifecycle.ts";

type GoalUpdateType =
  | "thread_goal_update"
  | "thread_goal_completed"
  | "thread_goal_cleared";

/**
 * Projects Claude-owned Goal observations into one sidecar event contract.
 *
 * Claude exposes two provider shapes: internal SDK `active_goal` messages and
 * top-level `goal_status` transcript attachments emitted by native /goal.
 * Keep both provider shapes inside this boundary; downstream runtime code only
 * sees normalized Goal state.
 */
export class ClaudeGoalProjection {
  private readonly turns: TurnLifecycle;
  private readonly emit: ClaudeSDKSidecarEventEmitter;
  private activeGoal: Record<string, unknown> | undefined;

  constructor(turns: TurnLifecycle, emit: ClaudeSDKSidecarEventEmitter) {
    this.turns = turns;
    this.emit = emit;
  }

  handle(message: Record<string, unknown>): boolean {
    const messageType = stringValue(message.type);
    if (messageType === "active_goal") {
      this.handleActiveGoal(message);
      return true;
    }
    if (messageType !== "attachment") {
      return false;
    }
    const attachment = recordValue(message.attachment);
    if (!attachment || stringValue(attachment.type) !== "goal_status") {
      return false;
    }
    this.handleGoalStatus(attachment);
    return true;
  }

  /**
   * Claude's native Goal evaluator may stop at the provider idle boundary
   * without writing a terminal goal_status attachment. Once the transcript
   * has been drained at that boundary, an otherwise-active Goal is blocked:
   * it is no longer running, but remains resumable by the user.
   */
  handleProviderIdle(): boolean {
    if (!this.activeGoal) {
      return false;
    }
    this.emitObservation("thread_goal_update", "goal_status", {
      ...this.activeGoal,
      status: "blocked"
    });
    this.activeGoal = undefined;
    return true;
  }

  trackGoalCommand(action: "set" | "clear", prompt: string): void {
    if (action === "clear") {
      this.activeGoal = undefined;
      return;
    }
    const objective = prompt.replace(/^\s*\/goal(?:\s+|$)/i, "").trim();
    if (objective) {
      this.activeGoal = { objective, status: "active" };
    }
  }

  private handleActiveGoal(message: Record<string, unknown>): void {
    if (!Object.hasOwn(message, "value")) {
      return;
    }
    const rawValue = message.value;
    if (rawValue === null) {
      this.emitObservation(
        this.turns.activeTurn?.goalAction === "clear"
          ? "thread_goal_cleared"
          : "thread_goal_completed",
        "active_goal"
      );
      this.activeGoal = undefined;
      return;
    }
    const value = recordValue(rawValue);
    const condition = stringValue(value?.condition);
    if (!value || !condition || !isNonNegativeNumber(value.iterations)) {
      return;
    }
    const goal: Record<string, unknown> = {
      objective: condition,
      status: "active",
      iterations: numberValue(value.iterations)
    };
    const reason = stringValue(value.last_reason);
    if (reason) {
      goal.reason = reason;
    }
    this.activeGoal = goal;
    this.emitObservation("thread_goal_update", "active_goal", goal);
  }

  private handleGoalStatus(attachment: Record<string, unknown>): void {
    const condition = stringValue(attachment.condition);
    if (!condition || typeof attachment.met !== "boolean") {
      return;
    }
    const goal: Record<string, unknown> = {
      objective: condition,
      status: attachment.met ? "complete" : "active"
    };
    copyString(attachment, goal, "reason");
    copyNonNegativeNumber(attachment, goal, "iterations");
    copyNonNegativeNumber(attachment, goal, "durationMs");
    copyNonNegativeNumber(attachment, goal, "tokens");
    if (typeof attachment.sentinel === "boolean") {
      goal.sentinel = attachment.sentinel;
    }
    this.activeGoal = attachment.met ? undefined : goal;
    this.emitObservation("thread_goal_update", "goal_status", goal);
  }

  private emitObservation(
    updateType: GoalUpdateType,
    source: "active_goal" | "goal_status",
    goal?: Record<string, unknown>
  ): void {
    const activeTurn = this.turns.activeTurn;
    this.emit({
      type: "goal_observed",
      payload: {
        // Claude's native Goal evaluator can flush goal_status after the SDK
        // result settles. Retain attribution to the latest root Turn when no
        // newer Turn is active.
        turnId: this.turns.lastTurnId,
        ...(this.turns.lastProviderTurnId
          ? { providerTurnId: this.turns.lastProviderTurnId }
          : {}),
        ...(activeTurn?.goalAction ? { action: activeTurn.goalAction } : {}),
        source,
        updateType,
        ...(goal ? { goal } : {})
      }
    });
  }
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function copyNonNegativeNumber(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string
): void {
  if (isNonNegativeNumber(source[key])) {
    target[key] = source[key];
  }
}

function copyString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string
): void {
  const value = stringValue(source[key]);
  if (value) {
    target[key] = value;
  }
}
