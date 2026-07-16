import type {
  TuttidEventStreamClient,
  TrackEvent
} from "@tutti-os/client-tuttid-ts";
import type {
  AnalyticsDebugEventServiceSnapshot,
  IAnalyticsDebugEventService
} from "../analyticsDebugEventService.interface";

const MAX_DEBUG_EVENTS = 200;

interface AnalyticsDebugEventServiceDependencies {
  eventStreamClient?: Pick<TuttidEventStreamClient, "connect" | "subscribe">;
}

type AnalyticsDebugReportedEvent = {
  clientTs: number;
  name: string;
  params: Record<string, unknown>;
};

export class AnalyticsDebugEventService implements IAnalyticsDebugEventService {
  readonly _serviceBrand: undefined;

  private events: TrackEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private unsubscribeEventStream: (() => void) | null = null;

  constructor(dependencies: AnalyticsDebugEventServiceDependencies = {}) {
    if (dependencies.eventStreamClient) {
      this.connectEventStream(dependencies.eventStreamClient);
    }
  }

  clear(): void {
    if (this.events.length === 0) {
      return;
    }

    this.events = [];
    this.emit();
  }

  dispose(): void {
    this.unsubscribeEventStream?.();
    this.unsubscribeEventStream = null;
    this.listeners.clear();
  }

  getSnapshot(): AnalyticsDebugEventServiceSnapshot {
    return this.events;
  }

  recordEvents(events: TrackEvent[]): void {
    if (events.length === 0) {
      return;
    }

    this.events = [
      ...this.events,
      ...events.map((event) => copyTrackEvent(event))
    ].slice(-MAX_DEBUG_EVENTS);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private connectEventStream(
    eventStreamClient: Pick<TuttidEventStreamClient, "connect" | "subscribe">
  ): void {
    this.unsubscribeEventStream = eventStreamClient.subscribe(
      "analytics.debug.reported",
      (event) => {
        this.recordReportedEvents(event.payload.events);
      }
    );
    void eventStreamClient.connect().catch(() => undefined);
  }

  private recordReportedEvents(
    events: readonly AnalyticsDebugReportedEvent[]
  ): void {
    this.recordEvents(
      events.map((event) => ({
        client_ts: event.clientTs,
        name: event.name,
        params: { ...event.params }
      }))
    );
  }
}

function copyTrackEvent(event: TrackEvent): TrackEvent {
  return {
    client_ts: event.client_ts,
    name: event.name,
    ...(event.params ? { params: { ...event.params } } : {})
  };
}
