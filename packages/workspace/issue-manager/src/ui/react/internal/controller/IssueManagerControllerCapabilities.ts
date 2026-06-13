import type {
  IssueManagerAgentProviderOption,
  IssueManagerFileAdapter
} from "../../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../../core/index.ts";

export const defaultIssueManagerAgentProviderOptions = [
  {
    label: "Codex",
    provider: "codex"
  }
] as const satisfies readonly IssueManagerAgentProviderOption[];

export function resolveIssueManagerAgentProviderOptions(
  feature: IssueManagerFeature
): readonly IssueManagerAgentProviderOption[] {
  if (!feature.agentProviderOptions) {
    return defaultIssueManagerAgentProviderOptions;
  }

  const configuredOptions = feature.agentProviderOptions.getOptions();
  const normalizedOptions = configuredOptions
    .map((option) => {
      const disabledReason = option.disabledReason?.trim();
      return {
        ...(option.disabled === true ? { disabled: true } : {}),
        ...(disabledReason ? { disabledReason } : {}),
        ...(option.iconUrl?.trim() ? { iconUrl: option.iconUrl.trim() } : {}),
        label: option.label.trim() || option.provider.trim(),
        provider: option.provider.trim()
      };
    })
    .filter((option) => option.provider && option.label);

  return normalizedOptions;
}

export interface IssueManagerControllerCapabilities {
  canOpenAgentSessions: boolean;
  canSelectExecutionDirectory: boolean;
  canInviteCollaborators: boolean;
  canReferenceWorkspaceFiles: boolean;
  canUploadWorkspaceFiles: boolean;
}

export function resolveIssueManagerControllerCapabilities(
  feature: IssueManagerFeature
): IssueManagerControllerCapabilities {
  return {
    canOpenAgentSessions:
      typeof feature.agentSessionOpener?.openSession === "function",
    canSelectExecutionDirectory: Boolean(
      feature.executionDirectoryPicker?.service
    ),
    canInviteCollaborators:
      feature.ui.showInviteCollaborator === true &&
      typeof feature.shareAdapter?.createIssueLink === "function",
    canReferenceWorkspaceFiles:
      hasFileAdapterMethod(feature.fileAdapter, "requestReferences") ||
      hasFileAdapterMethod(feature.fileAdapter, "loadReferenceTree") ||
      hasFileAdapterMethod(feature.fileAdapter, "listDirectory") ||
      hasFileAdapterMethod(feature.fileAdapter, "searchReferences"),
    canUploadWorkspaceFiles: hasFileAdapterMethod(
      feature.fileAdapter,
      "requestUpload"
    )
  };
}

function hasFileAdapterMethod(
  fileAdapter: IssueManagerFileAdapter | undefined,
  methodName:
    | "listDirectory"
    | "loadReferenceTree"
    | "requestReferences"
    | "requestUpload"
    | "searchReferences"
): boolean {
  return typeof Reflect.get(fileAdapter ?? {}, methodName) === "function";
}
