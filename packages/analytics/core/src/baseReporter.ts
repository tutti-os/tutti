import type {
  IReporterService,
  ReporterEventParams
} from "./reporterService.ts";

export type AnalyticsReporterParamValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type AnalyticsReporterParams = Record<
  string,
  AnalyticsReporterParamValue
>;

export interface AnalyticsReporterDependencies {
  reporterService: Pick<IReporterService, "trackEvents">;
  now?: () => number;
}

/**
 * Product-neutral base class for typed business-event reporters.
 *
 * Event names and parameter types remain owned by the consuming domain. This
 * base only handles event construction, timestamps, and camelCase-to-snake_case
 * protocol parameter names.
 */
export abstract class BaseAnalyticsReporter<TParams extends object> {
  protected abstract readonly eventName: string;

  private readonly params: TParams;
  private readonly reporterService: Pick<IReporterService, "trackEvents">;
  private readonly now: () => number;

  protected constructor(
    params: TParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    this.params = params;
    this.reporterService = dependencies.reporterService;
    this.now = dependencies.now ?? Date.now;
  }

  async report(): Promise<void> {
    await this.reporterService.trackEvents([
      {
        clientTS: this.now(),
        name: this.eventName,
        params: this.toProtocolParams()
      }
    ]);
  }

  protected toProtocolParams(): ReporterEventParams {
    return toAnalyticsProtocolParams(this.params);
  }
}

export function toAnalyticsProtocolParams(params: object): ReporterEventParams {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      toAnalyticsParamName(key),
      value
    ])
  );
}

export function toAnalyticsParamName(name: string): string {
  return name.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}
