export const tuttiAssetProtocolScheme = "tutti-asset";

export const tuttiAgentAssetUrls = {
  claudeCode: `${tuttiAssetProtocolScheme}://agent/claudecode.png`,
  codex: `${tuttiAssetProtocolScheme}://agent/codex.png`,
  cursor: `${tuttiAssetProtocolScheme}://agent/cursor.png`,
  hermes: `${tuttiAssetProtocolScheme}://agent/hermes.png`,
  openclaw: `${tuttiAssetProtocolScheme}://agent/openclaw.png`,
  opencode: `${tuttiAssetProtocolScheme}://agent/opencode.png`,
  tuttiAgent: `${tuttiAssetProtocolScheme}://agent/tutti.png`
} as const;

export const tuttiAgentAssetUrlsByIconKey: Readonly<Record<string, string>> = {
  "claude-code": tuttiAgentAssetUrls.claudeCode,
  codex: tuttiAgentAssetUrls.codex,
  cursor: tuttiAgentAssetUrls.cursor,
  hermes: tuttiAgentAssetUrls.hermes,
  openclaw: tuttiAgentAssetUrls.openclaw,
  opencode: tuttiAgentAssetUrls.opencode,
  tutti: tuttiAgentAssetUrls.tuttiAgent
};

export const tuttiIssueAssetUrls = {
  default: `${tuttiAssetProtocolScheme}://issue/default.png`
} as const;

export const tuttiFileAssetUrls = {
  default: `${tuttiAssetProtocolScheme}://file/default.png`
} as const;

export const tuttiFolderAssetUrls = {
  default: `${tuttiAssetProtocolScheme}://folder/default.png`
} as const;
