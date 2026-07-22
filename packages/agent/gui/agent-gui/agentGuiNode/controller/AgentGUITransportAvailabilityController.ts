import type { SessionRuntimeAvailability } from "@tutti-os/agent-activity-core";
import {
  agentGuiScheduler,
  type AgentGuiScheduledTask,
  type AgentGuiScheduler
} from "../agentGuiScheduler";

export const AGENT_GUI_TRANSPORT_RECONNECT_NOTICE_DELAY_MS = 300;

interface TransportAvailabilitySource {
  getAvailability(): SessionRuntimeAvailability | null;
  subscribe(listener: () => void): () => void;
}

interface AgentGUITransportAvailabilityControllerInput {
  scheduler?: AgentGuiScheduler;
  source: TransportAvailabilitySource;
}

const RECONNECTING_AVAILABILITY: SessionRuntimeAvailability = {
  state: "blocked",
  reason: "transport_reconnecting"
};
const UNAVAILABLE_AVAILABILITY: SessionRuntimeAvailability = {
  state: "blocked",
  reason: "transport_unavailable"
};

export class AgentGUITransportAvailabilityController {
  readonly getSnapshot = (): SessionRuntimeAvailability | null => this.snapshot;
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
  private readonly source: TransportAvailabilitySource;
  private revealTask: AgentGuiScheduledTask | null = null;
  private snapshot: SessionRuntimeAvailability | null;
  private unsubscribeSource: (() => void) | null = null;

  constructor(input: AgentGUITransportAvailabilityControllerInput) {
    this.scheduler = input.scheduler ?? agentGuiScheduler;
    this.source = input.source;
    this.snapshot = this.projectImmediateAvailability();
  }

  private readonly handleSourceChange = (): void => this.reconcile();

  private reconcile(): void {
    const availability = this.source.getAvailability();
    const reason =
      availability?.state === "blocked" ? availability.reason : null;
    if (reason === "transport_unavailable") {
      this.cancelReveal();
      this.publish(UNAVAILABLE_AVAILABILITY);
      return;
    }
    if (reason !== "transport_reconnecting") {
      this.cancelReveal();
      this.publish(null);
      return;
    }
    if (this.snapshot === RECONNECTING_AVAILABILITY || this.revealTask) return;
    this.revealTask = this.scheduler.schedule(
      AGENT_GUI_TRANSPORT_RECONNECT_NOTICE_DELAY_MS,
      () => {
        this.revealTask = null;
        const current = this.source.getAvailability();
        if (
          this.listeners.size > 0 &&
          current?.state === "blocked" &&
          current.reason === "transport_reconnecting"
        ) {
          this.publish(RECONNECTING_AVAILABILITY);
        }
      }
    );
  }

  private projectImmediateAvailability(): SessionRuntimeAvailability | null {
    const availability = this.source.getAvailability();
    return availability?.state === "blocked" &&
      availability.reason === "transport_unavailable"
      ? UNAVAILABLE_AVAILABILITY
      : null;
  }

  private cancelReveal(): void {
    this.revealTask?.cancel();
    this.revealTask = null;
  }

  private publish(next: SessionRuntimeAvailability | null): void {
    if (this.snapshot === next) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
