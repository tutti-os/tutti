import type { AgentGUITargetConnectionStatus } from "../../../types";
import {
  agentGuiScheduler,
  type AgentGuiScheduledTask,
  type AgentGuiScheduler
} from "../agentGuiScheduler";

export const AGENT_GUI_TARGET_CONNECTING_NOTICE_DELAY_MS = 300;

export interface AgentGUITargetConnectionBinding {
  getSnapshot(): AgentGUITargetConnectionStatus | null;
  subscribe(listener: () => void): () => void;
}

interface AgentGUITargetConnectionControllerInput {
  scheduler?: AgentGuiScheduler;
  source: AgentGUITargetConnectionBinding;
}

export class AgentGUITargetConnectionController {
  readonly getSnapshot = (): AgentGUITargetConnectionStatus | null =>
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
  private snapshot: AgentGUITargetConnectionStatus | null;
  private unsubscribeSource: (() => void) | null = null;

  constructor(input: AgentGUITargetConnectionControllerInput) {
    this.scheduler = input.scheduler ?? agentGuiScheduler;
    this.source = input.source;
    this.snapshot = this.projectImmediateStatus();
  }

  private readonly handleSourceChange = (): void => this.reconcile();

  private reconcile(): void {
    const status = this.source.getSnapshot();
    if (status === "unavailable") {
      this.cancelReveal();
      this.publish("unavailable");
      return;
    }
    if (status !== "connecting") {
      this.cancelReveal();
      this.publish(null);
      return;
    }
    if (this.snapshot === "connecting" || this.revealTask) return;
    this.revealTask = this.scheduler.schedule(
      AGENT_GUI_TARGET_CONNECTING_NOTICE_DELAY_MS,
      () => {
        this.revealTask = null;
        if (
          this.listeners.size > 0 &&
          this.source.getSnapshot() === "connecting"
        ) {
          this.publish("connecting");
        }
      }
    );
  }

  private projectImmediateStatus(): AgentGUITargetConnectionStatus | null {
    return this.source.getSnapshot() === "unavailable" ? "unavailable" : null;
  }

  private cancelReveal(): void {
    this.revealTask?.cancel();
    this.revealTask = null;
  }

  private publish(next: AgentGUITargetConnectionStatus | null): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
