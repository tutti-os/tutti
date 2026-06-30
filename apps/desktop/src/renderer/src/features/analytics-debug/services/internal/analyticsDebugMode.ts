export interface AnalyticsDebugModeInput {
  isDev?: boolean;
}

export function isAnalyticsDebugAvailable(
  _input: AnalyticsDebugModeInput = {}
): boolean {
  return true;
}
