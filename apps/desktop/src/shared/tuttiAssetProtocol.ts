export const tuttiAssetProtocolScheme = "tutti-asset";

export const tuttiAgentAssetUrls = {
  claudeCode: `${tuttiAssetProtocolScheme}://agent/claudecode.png`,
  codex: `${tuttiAssetProtocolScheme}://agent/codex.png`
} as const;

export const tuttiIssueAssetUrls = {
  default: `${tuttiAssetProtocolScheme}://issue/default.png`
} as const;

export const tuttiFileAssetUrls = {
  default: `${tuttiAssetProtocolScheme}://file/default.png`
} as const;

export const tuttiFolderAssetUrls = {
  default: `${tuttiAssetProtocolScheme}://folder/default.png`
} as const;
