import {
  ReporterService as SharedReporterService,
  type AnalyticsTransportEvent
} from "@tutti-os/analytics";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopWorkspaceUiMode } from "@shared/preferences";

export interface ReporterServiceDependencies {
  tuttidClient: Pick<TuttidClient, "trackEvents">;
  mode: DesktopWorkspaceUiMode;
  now?: () => number;
}

export class ReporterService extends SharedReporterService {
  constructor(dependencies: ReporterServiceDependencies) {
    super({
      commonParams: {
        mode: dependencies.mode
      },
      now: dependencies.now,
      transport: {
        async trackEvents(events: readonly AnalyticsTransportEvent[]) {
          await dependencies.tuttidClient.trackEvents(
            events.map((event) => ({
              client_ts: event.clientTS,
              name: event.name,
              params: event.params
            }))
          );
        }
      }
    });
  }
}
