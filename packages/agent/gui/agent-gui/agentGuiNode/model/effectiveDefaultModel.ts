import type {
  AgentGUIComposerSettingOption,
  AgentGUIComposerSettingsVM
} from "./agentGuiNodeTypes";

export function effectiveDefaultModelOption(
  composerSettings: AgentGUIComposerSettingsVM,
  options: AgentGUIComposerSettingsVM["availableModels"]
): AgentGUIComposerSettingOption | null {
  if (selectedModelValue(composerSettings) !== "default") {
    return null;
  }
  const effectiveValue = composerSettings.effectiveModelValue?.trim();
  if (!effectiveValue || effectiveValue.toLowerCase() === "default") {
    return null;
  }
  const exact = options.find(
    (option) =>
      option.value !== "default" &&
      option.value.toLowerCase() === effectiveValue.toLowerCase()
  );
  if (exact) {
    return exact;
  }
  const effectiveTokens = modelIdentityTokens(effectiveValue);
  let best: AgentGUIComposerSettingOption | null = null;
  let bestTokenCount = 0;
  for (const option of options) {
    if (option.value === "default") {
      continue;
    }
    for (const candidate of [option.value, option.label]) {
      const candidateTokens = modelIdentityTokens(candidate);
      if (
        candidateTokens.length === 0 ||
        candidateTokens.some((token) => !effectiveTokens.includes(token))
      ) {
        continue;
      }
      if (candidateTokens.length > bestTokenCount) {
        best = option;
        bestTokenCount = candidateTokens.length;
      }
    }
  }
  return best ?? { value: effectiveValue, label: effectiveValue };
}

function selectedModelValue(
  composerSettings: AgentGUIComposerSettingsVM
): string | null {
  return (
    composerSettings.selectedModelValue ??
    composerSettings.draftSettings.model ??
    null
  );
}

function modelIdentityTokens(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/u, "")
    .split(/[^a-z0-9]+/u)
    .filter(
      (token) =>
        token.length > 1 &&
        !/^\d+$/u.test(token) &&
        token !== "claude" &&
        token !== "latest"
    );
}
