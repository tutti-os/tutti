import type { TuttidClient, TrackEvent } from "@tutti-os/client-tuttid-ts";
import type { DesktopWorkspaceUiMode } from "@shared/preferences";
import type {
  IReporterService,
  ReporterEventInput,
  ReporterEventParams
} from "../reporterService.interface";

export interface ReporterServiceDependencies {
  tuttidClient: Pick<TuttidClient, "trackEvents">;
  mode: DesktopWorkspaceUiMode;
  now?: () => number;
}

export class ReporterService implements IReporterService {
  readonly _serviceBrand: undefined;

  private readonly tuttidClient: Pick<TuttidClient, "trackEvents">;
  private readonly mode: DesktopWorkspaceUiMode;
  private readonly now: () => number;

  constructor(dependencies: ReporterServiceDependencies) {
    this.tuttidClient = dependencies.tuttidClient;
    this.mode = dependencies.mode;
    this.now = dependencies.now ?? Date.now;
  }

  async track(name: string, params?: ReporterEventParams): Promise<void> {
    await this.trackEvents([{ name, params }]);
  }

  async trackEvents(events: ReporterEventInput[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    try {
      const tuttidEvents = events.map((event) => this.toTuttidEvent(event));
      await this.tuttidClient.trackEvents(tuttidEvents);
    } catch {
      // Analytics is best-effort in the renderer and must not affect product flows.
    }
  }

  private toTuttidEvent(event: ReporterEventInput): TrackEvent {
    const tuttidEvent: TrackEvent = {
      client_ts: event.clientTS ?? this.now(),
      name: event.name,
      params: {
        ...event.params,
        mode: this.mode
      }
    };
    return tuttidEvent;
  }
}
