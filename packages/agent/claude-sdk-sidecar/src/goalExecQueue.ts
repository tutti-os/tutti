import { emit } from "./eventSink.ts";

export type GoalCommandDispatch = {
  operationId: string;
  revision: number;
  repairEpoch?: number;
  action: "set" | "clear";
};

export type GoalExecInput = {
  turnId: string;
  promptCorrelationId?: string;
  prompt: string;
  content?: unknown;
  turnOrigin?: string;
  hostContext?: string;
  goal: GoalCommandDispatch;
};

export class GoalExecQueue {
  private pending: GoalExecInput[] = [];
  private dispatchScheduled = false;
  private readonly dispatch: (input: GoalExecInput) => void;

  constructor(dispatch: (input: GoalExecInput) => void) {
    this.dispatch = dispatch;
  }

  accept(input: GoalExecInput): void {
    if (input.goal.action === "clear") {
      const retained: GoalExecInput[] = [];
      for (const pending of this.pending) {
        if (
          pending.goal.action === "set" &&
          pending.goal.revision < input.goal.revision
        ) {
          emit({
            type: "goal_command_superseded",
            payload: {
              turnId: pending.turnId,
              operationId: pending.goal.operationId,
              revision: pending.goal.revision,
              action: pending.goal.action,
              supersededByRevision: input.goal.revision
            }
          });
          continue;
        }
        retained.push(pending);
      }
      this.pending = retained;
    }
    this.pending.push(input);
    if (this.dispatchScheduled) {
      return;
    }
    this.dispatchScheduled = true;
    setTimeout(() => this.drain(), 0);
  }

  cancelExact(turnId: string): GoalExecInput | undefined {
    const expected = turnId.trim();
    if (!expected) {
      return undefined;
    }
    const index = this.pending.findIndex(
      (input) => input.turnId.trim() === expected
    );
    if (index < 0) {
      return undefined;
    }
    const [canceled] = this.pending.splice(index, 1);
    return canceled;
  }

  private drain(): void {
    this.dispatchScheduled = false;
    const pending = this.pending;
    this.pending = [];
    for (const input of pending) {
      this.dispatch(input);
    }
  }
}
