import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";

type ClaudeTaskState = {
  id: string;
  subject: string;
  description?: string;
  status: string;
};

export class TaskPlanTracker {
  private readonly tasks = new Map<string, ClaudeTaskState>();
  private readonly activeTurnId: () => string;
  private readonly emit: ClaudeSDKSidecarEventEmitter;

  constructor(activeTurnId: () => string, emit: ClaudeSDKSidecarEventEmitter) {
    this.activeTurnId = activeTurnId;
    this.emit = emit;
  }

  reset(): void {
    this.tasks.clear();
  }

  create(id: string, subject: string, description = ""): boolean {
    if (!id || !subject || this.tasks.has(id)) {
      return false;
    }
    this.tasks.set(id, {
      id,
      subject,
      ...(description ? { description } : {}),
      status: "pending"
    });
    this.emitUpdated();
    return true;
  }

  complete(id: string): boolean {
    const existing = this.tasks.get(id);
    if (!existing || existing.status === "completed") {
      return false;
    }
    this.tasks.set(id, { ...existing, status: "completed" });
    this.emitUpdated();
    return true;
  }

  private emitUpdated(): void {
    this.emit({
      type: "plan_updated",
      payload: {
        turnId: this.activeTurnId(),
        entries: [...this.tasks.values()].map((task) => ({
          id: task.id,
          content: task.subject,
          status: task.status,
          ...(task.description ? { description: task.description } : {})
        }))
      }
    });
  }
}
