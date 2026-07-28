import { AnalyticsDebugEventStore } from "@tutti-os/analytics-debug";
import type { TuttidEventStreamClient } from "@tutti-os/client-tuttid-ts";
import type { IAnalyticsDebugEventService } from "../analyticsDebugEventService.interface";

interface AnalyticsDebugEventServiceDependencies {
  eventStreamClient?: Pick<TuttidEventStreamClient, "connect" | "subscribe">;
}

type AnalyticsDebugReportedEvent = {
  clientTs: number;
  name: string;
  params: Record<string, unknown>;
};

export class AnalyticsDebugEventService
  extends AnalyticsDebugEventStore
  implements IAnalyticsDebugEventService
{
  readonly _serviceBrand: undefined;

  private unsubscribeEventStream: (() => void) | null = null;

  constructor(dependencies: AnalyticsDebugEventServiceDependencies = {}) {
    super();
    if (dependencies.eventStreamClient) {
      this.connectEventStream(dependencies.eventStreamClient);
    }
  }

  override dispose(): void {
    this.unsubscribeEventStream?.();
    this.unsubscribeEventStream = null;
    super.dispose();
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
        clientTS: event.clientTs,
        name: event.name,
        params: { ...event.params }
      }))
    );
  }
}
