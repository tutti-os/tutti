function agentIconUrl(fileName: string): string {
  return new URL(
    `./app/renderer/assets/icons/agents/${fileName}`,
    import.meta.url
  ).href;
}

export const manageAgentClaudeCodeUrl = agentIconUrl(
  "manage-agent-claude-code.png"
);
export const manageAgentCodexUrl = agentIconUrl("manage-agent-codex.png");
export const manageAgentGeminiUrl = agentIconUrl("manage-agent-gemini.png");
export const manageAgentHermesUrl = agentIconUrl("manage-agent-hermes.png");
export const manageAgentNextopUrl = agentIconUrl("manage-agent-nextop.png");
export const manageAgentOpenclawUrl = agentIconUrl("manage-agent-openclaw.png");
export const claudeRoundedUrl = agentIconUrl("claude-rounded.png");
export const codexRoundedUrl = agentIconUrl("codex-rounded.png");
export const geminiRoundedUrl = agentIconUrl("gemini-rounded.png");
export const hermesRoundedUrl = agentIconUrl("hermes-rounded.png");
export const nextopDocRoundedUrl = agentIconUrl("nextop-doc-rounded.png");
export const openclawRoundedUrl = agentIconUrl("openclaw-rounded.png");
