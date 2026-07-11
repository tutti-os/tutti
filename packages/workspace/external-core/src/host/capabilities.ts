import type {
  TuttiExternalCapabilities,
  TuttiExternalOperation
} from "../contracts/index.ts";
import { tuttiExternalOperations } from "../contracts/index.ts";
import {
  isTuttiExternalAtProviderId,
  isTuttiExternalManagedAiModelProviderId,
  isTuttiExternalWorkspaceAgentProvider,
  isTuttiExternalWorkspaceFeature
} from "../core/index.ts";

const tuttiExternalOperationSet = new Set<string>(tuttiExternalOperations);

export function normalizeTuttiExternalCapabilities(
  capabilities: TuttiExternalCapabilities
): TuttiExternalCapabilities {
  if (typeof capabilities !== "object" || capabilities === null) {
    throw new Error("tuttiExternal host capabilities must be an object.");
  }
  return Object.freeze({
    operations: normalizeCapabilityArray(
      capabilities.operations,
      "operations",
      (value): value is TuttiExternalOperation =>
        typeof value === "string" && tuttiExternalOperationSet.has(value)
    ),
    ...(capabilities.atProviders !== undefined
      ? {
          atProviders: normalizeCapabilityArray(
            capabilities.atProviders,
            "atProviders",
            isTuttiExternalAtProviderId
          )
        }
      : {}),
    ...(capabilities.workspaceFeatures !== undefined
      ? {
          workspaceFeatures: normalizeCapabilityArray(
            capabilities.workspaceFeatures,
            "workspaceFeatures",
            isTuttiExternalWorkspaceFeature
          )
        }
      : {}),
    ...(capabilities.workspaceAgentProviders !== undefined
      ? {
          workspaceAgentProviders: normalizeCapabilityArray(
            capabilities.workspaceAgentProviders,
            "workspaceAgentProviders",
            isTuttiExternalWorkspaceAgentProvider
          )
        }
      : {}),
    ...(capabilities.managedAiProviders !== undefined
      ? {
          managedAiProviders: normalizeCapabilityArray(
            capabilities.managedAiProviders,
            "managedAiProviders",
            isTuttiExternalManagedAiModelProviderId
          )
        }
      : {})
  });
}

export function supportsTuttiExternalOperation(
  capabilities: TuttiExternalCapabilities,
  operation: TuttiExternalOperation
): boolean {
  return capabilities.operations.includes(operation);
}

function normalizeCapabilityArray<T>(
  values: unknown,
  field: string,
  guard: (value: unknown) => value is T
): readonly T[] {
  if (!Array.isArray(values) || values.some((value) => !guard(value))) {
    throw new Error(`tuttiExternal host ${field} capabilities are invalid.`);
  }
  return Object.freeze([...new Set(values)]);
}
