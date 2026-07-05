export interface AppFactoryProviderDefaultOption {
  readonly agentTargetId?: string;
  readonly disabled?: boolean;
  readonly provider: string;
}

export const DEFAULT_APP_FACTORY_PROVIDER = "codex";

export function resolveDefaultAppFactoryProvider(
  options: readonly AppFactoryProviderDefaultOption[],
  preferredAgentTargetId?: string | null
): string {
  const normalizedPreferredAgentTargetId = preferredAgentTargetId?.trim() ?? "";
  const preferredOption = options.find(
    (option) =>
      normalizedPreferredAgentTargetId !== "" &&
      option.disabled !== true &&
      ((option.agentTargetId ?? option.provider) ===
        normalizedPreferredAgentTargetId ||
        option.provider === normalizedPreferredAgentTargetId)
  );
  const defaultProviderOption = options.find(
    (option) =>
      option.disabled !== true &&
      option.provider === DEFAULT_APP_FACTORY_PROVIDER
  );
  const firstEnabledOption = options.find((option) => option.disabled !== true);
  const fallbackDefaultProviderOption = options.find(
    (option) => option.provider === DEFAULT_APP_FACTORY_PROVIDER
  );
  return (
    selectionValue(preferredOption) ??
    selectionValue(defaultProviderOption) ??
    selectionValue(firstEnabledOption) ??
    selectionValue(fallbackDefaultProviderOption) ??
    selectionValue(options[0]) ??
    ""
  );
}

export function resolveSelectedAppFactoryProvider(
  currentAgentTargetId: string,
  options: readonly AppFactoryProviderDefaultOption[],
  preferredAgentTargetId?: string | null
): string {
  const normalizedCurrentAgentTargetId = currentAgentTargetId.trim();
  const currentOption = options.find(
    (option) =>
      normalizedCurrentAgentTargetId !== "" &&
      option.disabled !== true &&
      ((option.agentTargetId ?? option.provider) ===
        normalizedCurrentAgentTargetId ||
        option.provider === normalizedCurrentAgentTargetId)
  );
  return (
    selectionValue(currentOption) ??
    resolveDefaultAppFactoryProvider(options, preferredAgentTargetId)
  );
}

function selectionValue(
  option: AppFactoryProviderDefaultOption | undefined
): string | undefined {
  return option?.agentTargetId ?? option?.provider;
}
