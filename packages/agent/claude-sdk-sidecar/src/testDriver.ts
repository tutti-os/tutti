import { errorMessage } from "./errors.ts";
import { emit } from "./eventSink.ts";
import { InteractiveCoordinator } from "./interactive.ts";
import { TurnLifecycle } from "./turnLifecycle.ts";

export class SidecarTestDriver {
  private readonly turns: TurnLifecycle;
  private readonly interactions: InteractiveCoordinator;

  constructor(turns: TurnLifecycle, interactions: InteractiveCoordinator) {
    this.turns = turns;
    this.interactions = interactions;
  }

  exec(turnId: string, prompt: string): void {
    this.turns.activateTransient(turnId);
    if (prompt.includes("approval")) {
      void this.interactions
        .handleToolPermission(
          "Bash",
          { command: "touch approval.txt" },
          {
            signal: new AbortController().signal,
            suggestions: [],
            toolUseID: "test-approval-tool"
          }
        )
        .then(() => this.completeTurn(turnId, "Approval accepted."))
        .catch((error) => this.failTurn(turnId, error));
      return;
    }
    if (prompt.includes("ask-user")) {
      void this.interactions
        .handleToolPermission(
          "AskUserQuestion",
          {
            questions: [
              {
                header: "Choice",
                question: "Pick one",
                options: [{ label: "A", description: "Alpha" }]
              }
            ]
          },
          {
            signal: new AbortController().signal,
            toolUseID: "test-ask-user-tool"
          }
        )
        .then(() => this.completeTurn(turnId, "Question answered."))
        .catch((error) => this.failTurn(turnId, error));
      return;
    }
    if (prompt.includes("exit-plan")) {
      void this.interactions
        .handleToolPermission(
          "ExitPlanMode",
          { plan: "1. Inspect\n2. Implement\n3. Verify" },
          {
            signal: new AbortController().signal,
            toolUseID: "test-exit-plan-tool"
          }
        )
        .then(() => this.completeTurn(turnId, "Plan captured."))
        .catch((error) => this.failTurn(turnId, error));
      return;
    }
    emit({
      type: "assistant_delta",
      payload: {
        turnId,
        content: `Echo: ${prompt}`,
        snapshot: `Echo: ${prompt}`
      }
    });
    this.completeTurn(turnId, `Echo: ${prompt}`);
  }

  guide(prompt: string): void {
    emit({
      type: "assistant_delta",
      payload: {
        turnId: this.turns.activeId,
        content: `Echo: ${prompt}`,
        snapshot: `Echo: ${prompt}`
      }
    });
  }

  private completeTurn(turnId: string, content: string): void {
    emit({
      type: "assistant_completed",
      payload: { turnId, content }
    });
    emit({
      type: "turn_completed",
      payload: {
        turnId,
        stopReason: "end_turn"
      }
    });
  }

  private failTurn(turnId: string, error: unknown): void {
    emit({
      type: "turn_failed",
      payload: {
        turnId,
        error: errorMessage(error)
      }
    });
  }
}
