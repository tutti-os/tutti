import type { AgentGUITargetConnectionState } from "../../../types";
import {
  agentGuiScheduler,
  type AgentGuiScheduledTask,
  type AgentGuiScheduler
} from "../agentGuiScheduler";

export const AGENT_GUI_TARGET_CONNECTING_NOTICE_DELAY_MS = 300;

export interface AgentGUITargetConnectionBinding {
  getSnapshot(): AgentGUITargetConnectionState | null;
  subscribe(listener: () => void): () => void;
}

interface AgentGUITargetConnectionControllerInput {
  scheduler?: AgentGuiScheduler;
  source: AgentGUITargetConnectionBinding;
}

export class AgentGUITargetConnectionController {
  readonly getSnapshot = (): AgentGUITargetConnectionState | null =>
    this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.unsubscribeSource = this.source.subscribe(this.handleSourceChange);
      this.reconcile();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.unsubscribeSource?.();
        this.unsubscribeSource = null;
        this.cancelReveal();
      }
    };
  };

  private readonly listeners = new Set<() => void>();
  private readonly scheduler: AgentGuiScheduler;
  private readonly source: AgentGUITargetConnectionBinding;
  private revealTask: AgentGuiScheduledTask | null = null;
  private snapshot: AgentGUITargetConnectionState | null;
  private unsubscribeSource: (() => void) | null = null;

  constructor(input: AgentGUITargetConnectionControllerInput) {
    this.scheduler = input.scheduler ?? agentGuiScheduler;
    this.source = input.source;
    this.snapshot = this.projectImmediateStatus();
  }

  private readonly handleSourceChange = (): void => this.reconcile();

  private reconcile(): void {
    const state = this.source.getSnapshot();
    if (state?.status === "unavailable") {
      this.cancelReveal();
      this.publish(state);
      return;
    }
    if (state?.status !== "connecting") {
      this.cancelReveal();
      this.publish(null);
      return;
    }
    if (this.snapshot?.status === "connecting") {
      this.publish(state);
      return;
    }
    if (this.revealTask) return;
    this.revealTask = this.scheduler.schedule(
      AGENT_GUI_TARGET_CONNECTING_NOTICE_DELAY_MS,
      () => {
        this.revealTask = null;
        const current = this.source.getSnapshot();
        if (this.listeners.size > 0 && current?.status === "connecting") {
          this.publish(current);
        }
      }
    );
  }

  private projectImmediateStatus(): AgentGUITargetConnectionState | null {
    const state = this.source.getSnapshot();
    return state?.status === "unavailable" ? state : null;
  }

  private cancelReveal(): void {
    this.revealTask?.cancel();
    this.revealTask = null;
  }

  private publish(next: AgentGUITargetConnectionState | null): void {
    if (targetConnectionStatesEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function targetConnectionStatesEqual(
  left: AgentGUITargetConnectionState | null,
  right: AgentGUITargetConnectionState | null
): boolean {
  return (
    left?.status === right?.status && left?.retryAttempt === right?.retryAttempt
  );
}
