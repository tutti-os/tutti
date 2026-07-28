import { createDecorator } from "@tutti-os/infra/di";

export type ReporterEventParams = Record<string, unknown>;

export interface ReporterEventInput {
  name: string;
  clientTS?: number;
  params?: ReporterEventParams;
}

export interface AnalyticsTransportEvent {
  name: string;
  clientTS: number;
  params?: ReporterEventParams;
}

export interface AnalyticsTransport {
  trackEvents(events: readonly AnalyticsTransportEvent[]): Promise<void>;
}

export interface ReporterServiceDependencies {
  transport: AnalyticsTransport;
  commonParams?: ReporterEventParams | (() => ReporterEventParams | undefined);
  now?: () => number;
}

export interface IReporterService {
  readonly _serviceBrand: undefined;

  track(name: string, params?: ReporterEventParams): Promise<void>;
  trackEvents(events: ReporterEventInput[]): Promise<void>;
}

export const IReporterService =
  createDecorator<IReporterService>("reporter-service");

export class ReporterService implements IReporterService {
  readonly _serviceBrand: undefined;

  private readonly transport: AnalyticsTransport;
  private readonly commonParams:
    | ReporterEventParams
    | (() => ReporterEventParams | undefined)
    | undefined;
  private readonly now: () => number;

  constructor(dependencies: ReporterServiceDependencies) {
    this.transport = dependencies.transport;
    this.commonParams = dependencies.commonParams;
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
      const commonParams =
        typeof this.commonParams === "function"
          ? this.commonParams()
          : this.commonParams;
      const transportEvents = events.map((event) =>
        this.toTransportEvent(event, commonParams)
      );
      await this.transport.trackEvents(transportEvents);
    } catch {
      // Analytics is best-effort and must not affect renderer product flows.
    }
  }

  private toTransportEvent(
    event: ReporterEventInput,
    commonParams: ReporterEventParams | undefined
  ): AnalyticsTransportEvent {
    return {
      clientTS: event.clientTS ?? this.now(),
      name: event.name,
      params:
        event.params || commonParams
          ? {
              ...event.params,
              ...commonParams
            }
          : undefined
    };
  }
}
