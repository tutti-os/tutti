import type {
  AnalyticsDebugEventSnapshot,
  AnalyticsDebugEventStoreContract
} from "@tutti-os/analytics-debug";
import { createDecorator } from "@tutti-os/infra/di";

export type AnalyticsDebugEventServiceSnapshot = AnalyticsDebugEventSnapshot;

export interface IAnalyticsDebugEventService extends AnalyticsDebugEventStoreContract {
  readonly _serviceBrand: undefined;
}

export const IAnalyticsDebugEventService =
  createDecorator<IAnalyticsDebugEventService>("analytics-debug-event-service");
