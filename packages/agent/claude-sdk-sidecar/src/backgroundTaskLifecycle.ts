import { recordValue } from "./normalizer.ts";
import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";
import { stringValue } from "./runtimeValues.ts";

const BACKGROUND_TASK_QUIESCENCE_GRACE_MS = 250;

export interface DelegatedTaskCounts {
  known: number;
  running: number;
  completed: number;
  failed: number;
  stopped: number;
}

export class BackgroundTaskLifecycle {
  private readonly activeTurnId: () => string;
  private readonly lastTurnId: () => string;
  private readonly delegatedTaskCounts: (turnId: string) => DelegatedTaskCounts;
  private readonly emit: ClaudeSDKSidecarEventEmitter;
  private readonly onContinuationPending: () => void;
  private levelObserved = false;
  private liveTaskCount = 0;
  private readonly observedTaskIDs = new Set<string>();
  private levelContinuationPending = false;
  private taskNotificationContinuationPending = false;
  private rootResultSucceeded?: boolean;
  private quiescenceTimer?: ReturnType<typeof setTimeout>;

  constructor(options: {
    activeTurnId: () => string;
    lastTurnId: () => string;
    delegatedTaskCounts: (turnId: string) => DelegatedTaskCounts;
    emit: ClaudeSDKSidecarEventEmitter;
    onContinuationPending: () => void;
  }) {
    this.activeTurnId = options.activeTurnId;
    this.lastTurnId = options.lastTurnId;
    this.delegatedTaskCounts = options.delegatedTaskCounts;
    this.emit = options.emit;
    this.onContinuationPending = options.onContinuationPending;
  }

  reset(): void {
    this.clearQuiescenceTimer();
    this.levelObserved = false;
    this.liveTaskCount = 0;
    this.observedTaskIDs.clear();
    this.levelContinuationPending = false;
    this.taskNotificationContinuationPending = false;
    this.rootResultSucceeded = undefined;
  }

  cancel(): void {
    this.clearQuiescenceTimer();
    this.clearContinuation();
    this.rootResultSucceeded = false;
  }

  beginRootTurn(): void {
    this.clearContinuation();
    this.rootResultSucceeded = undefined;
  }

  close(): void {
    this.clearQuiescenceTimer();
  }

  handleLevelChanged(message: Record<string, unknown>): void {
    const tasks = Array.isArray(message.tasks) ? message.tasks : [];
    for (const task of tasks) {
      const taskID = stringValue(recordValue(task)?.task_id);
      if (taskID) {
        this.observedTaskIDs.add(taskID);
      }
    }
    const previousCount = this.liveTaskCount;
    const previouslyObserved = this.levelObserved;
    this.levelObserved = true;
    this.liveTaskCount = tasks.length;
    const turnId = this.activeTurnId() || this.lastTurnId();
    this.emit({
      type: "background_tasks_changed",
      payload: this.diagnosticPayload(turnId)
    });
    if (tasks.length > 0) {
      this.clearQuiescenceTimer();
      this.levelContinuationPending = false;
      return;
    }
    if (!previouslyObserved || previousCount === 0) {
      return;
    }
    this.levelContinuationPending = this.rootResultSucceeded !== false;
    this.scheduleQuiescence(turnId);
    this.reserveContinuation();
  }

  hasPendingContinuation(): boolean {
    return (
      this.levelContinuationPending || this.taskNotificationContinuationPending
    );
  }

  markTaskNotificationContinuation(): void {
    if (this.rootResultSucceeded !== false) {
      this.taskNotificationContinuationPending = true;
    }
  }

  clearContinuation(): boolean {
    const pending = this.hasPendingContinuation();
    this.levelContinuationPending = false;
    this.taskNotificationContinuationPending = false;
    return pending;
  }

  handleRootResultSettled(succeeded: boolean): void {
    this.rootResultSucceeded = succeeded;
    if (!succeeded) {
      this.clearContinuation();
      return;
    }
    this.reserveContinuation();
  }

  reserveContinuation(): void {
    if (
      this.rootResultSucceeded === false ||
      !this.hasPendingContinuation() ||
      this.activeTurnId()
    ) {
      return;
    }
    this.onContinuationPending();
  }

  private scheduleQuiescence(turnId: string): void {
    this.clearQuiescenceTimer();
    this.quiescenceTimer = setTimeout(() => {
      this.quiescenceTimer = undefined;
      if (this.liveTaskCount !== 0) {
        return;
      }
      this.emit({
        type: "background_tasks_quiesced",
        payload: this.diagnosticPayload(turnId)
      });
    }, BACKGROUND_TASK_QUIESCENCE_GRACE_MS);
    this.quiescenceTimer.unref?.();
  }

  private clearQuiescenceTimer(): void {
    if (this.quiescenceTimer === undefined) {
      return;
    }
    clearTimeout(this.quiescenceTimer);
    this.quiescenceTimer = undefined;
  }

  private diagnosticPayload(turnId: string): Record<string, unknown> {
    const delegated = this.delegatedTaskCounts(turnId);
    return {
      turnId,
      runningCount: this.liveTaskCount,
      backgroundTasksObservedCount: this.observedTaskIDs.size,
      backgroundTasksRunningCount: this.liveTaskCount,
      backgroundTasksNoLongerLiveCount: Math.max(
        0,
        this.observedTaskIDs.size - this.liveTaskCount
      ),
      delegatedTasksKnownCount: delegated.known,
      delegatedTasksRunningCount: delegated.running,
      delegatedTasksCompletedCount: delegated.completed,
      delegatedTasksFailedCount: delegated.failed,
      delegatedTasksStoppedCount: delegated.stopped
    };
  }
}
