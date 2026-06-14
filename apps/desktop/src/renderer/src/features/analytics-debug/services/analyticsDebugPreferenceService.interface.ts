import { createDecorator } from "@tutti-os/infra/di";

export interface AnalyticsDebugPreferenceReadableStoreState {
  readonly available: boolean;
  readonly enabled: boolean;
}

export interface AnalyticsDebugPreferenceStoreState {
  available: boolean;
  enabled: boolean;
}

export interface IAnalyticsDebugPreferenceService {
  readonly _serviceBrand: undefined;
  readonly store: AnalyticsDebugPreferenceReadableStoreState;

  setEnabled(enabled: boolean): void;
}

export const IAnalyticsDebugPreferenceService =
  createDecorator<IAnalyticsDebugPreferenceService>(
    "analytics-debug-preference-service"
  );
