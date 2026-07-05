import type {
  IssueManagerAgentTargetOption,
  IssueManagerFileAdapter
} from "../../../../contracts/index.ts";
import type { IssueManagerFeature } from "../../../../core/index.ts";

export const defaultIssueManagerAgentTargetOptions = [
  {
    agentTargetId: "local:codex",
    label: "Codex",
    provider: "codex"
  }
] as const satisfies readonly IssueManagerAgentTargetOption[];

export function resolveIssueManagerAgentTargetOptions(
  feature: IssueManagerFeature
): readonly IssueManagerAgentTargetOption[] {
  if (!feature.agentTargetOptions) {
    return defaultIssueManagerAgentTargetOptions;
  }

  const configuredOptions = feature.agentTargetOptions.getOptions();
  const normalizedOptions: IssueManagerAgentTargetOption[] = [];
  for (const option of configuredOptions) {
    const agentTargetId = option.agentTargetId?.trim();
    const disabledReason = option.disabledReason?.trim();
    const provider = option.provider.trim();
    if (!agentTargetId) {
      continue;
    }
    normalizedOptions.push({
      agentTargetId,
      ...(option.disabled === true ? { disabled: true } : {}),
      ...(disabledReason ? { disabledReason } : {}),
      ...(option.iconUrl?.trim() ? { iconUrl: option.iconUrl.trim() } : {}),
      label: option.label.trim() || provider || agentTargetId,
      provider
    });
  }

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
