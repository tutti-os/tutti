import { createDecorator } from "@tutti-os/infra/di";

export type ReporterEventParams = Record<string, unknown>;

export interface ReporterEventInput {
  name: string;
  clientTS?: number;
  params?: ReporterEventParams;
}

export interface IReporterService {
  readonly _serviceBrand: undefined;

  track(name: string, params?: ReporterEventParams): Promise<void>;
  trackEvents(events: ReporterEventInput[]): Promise<void>;
}

export const IReporterService =
  createDecorator<IReporterService>("reporter-service");
