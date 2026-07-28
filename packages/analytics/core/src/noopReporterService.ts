import type {
  IReporterService,
  ReporterEventInput,
  ReporterEventParams
} from "./reporterService.ts";

/** Reporter service used by optional analytics integrations. */
export class NoopReporterService implements IReporterService {
  readonly _serviceBrand: undefined;

  async track(_name: string, _params?: ReporterEventParams): Promise<void> {}

  async trackEvents(_events: ReporterEventInput[]): Promise<void> {}
}

export const noopReporterService: IReporterService = new NoopReporterService();
