import type {
  TuttiExternalCapabilities,
  TuttiExternalOperation
} from "../contracts/index.ts";

export function normalizeTuttiExternalCapabilities(
  capabilities: TuttiExternalCapabilities
): TuttiExternalCapabilities {
  return Object.freeze({
    operations: freezeUnique(capabilities.operations),
    ...(capabilities.atProviders
      ? { atProviders: freezeUnique(capabilities.atProviders) }
      : {}),
    ...(capabilities.workspaceFeatures
      ? { workspaceFeatures: freezeUnique(capabilities.workspaceFeatures) }
      : {}),
    ...(capabilities.workspaceAgentProviders
      ? {
          workspaceAgentProviders: freezeUnique(
            capabilities.workspaceAgentProviders
          )
        }
      : {}),
    ...(capabilities.managedAiProviders
      ? { managedAiProviders: freezeUnique(capabilities.managedAiProviders) }
      : {})
  });
}

export function supportsTuttiExternalOperation(
  capabilities: TuttiExternalCapabilities,
  operation: TuttiExternalOperation
): boolean {
  return capabilities.operations.includes(operation);
}

function freezeUnique<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)]);
}
