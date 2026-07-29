export interface AnalyticsDebugModeInput {
  isDev?: boolean;
}

export function isAnalyticsDebugAvailable(
  input: AnalyticsDebugModeInput = {}
): boolean {
  return input.isDev === true;
}
