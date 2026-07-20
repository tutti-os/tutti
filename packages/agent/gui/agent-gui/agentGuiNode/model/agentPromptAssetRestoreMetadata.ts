export interface AgentPromptAssetRestoreMetadata {
  assetId?: string;
  hostPath?: string;
  kind?: string;
  storagePolicy?: string;
  uploadStatus?: string;
  uri?: string;
}

export function normalizeAgentPromptAssetRestoreMetadata(
  input: AgentPromptAssetRestoreMetadata
): AgentPromptAssetRestoreMetadata {
  const assetId = input.assetId?.trim();
  const hostPath = input.hostPath?.trim();
  const kind = input.kind?.trim();
  const storagePolicy = input.storagePolicy?.trim();
  const uploadStatus = input.uploadStatus?.trim();
  const uri = input.uri?.trim();
  return {
    ...(assetId ? { assetId } : {}),
    ...(hostPath ? { hostPath } : {}),
    ...(kind ? { kind } : {}),
    ...(storagePolicy ? { storagePolicy } : {}),
    ...(uploadStatus ? { uploadStatus } : {}),
    ...(uri ? { uri } : {})
  };
}
