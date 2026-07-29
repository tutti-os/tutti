/**
 * DOM-free Composer projections for alternate renderers such as Mobile.
 *
 * The workspace engine remains the owner of option loading and settings
 * commands. Consumers receive canonical activity-core data and retain only
 * their local visual controls and disclosure state.
 */
import type {
  AgentActivityComposerOptions,
  AgentActivitySession,
  AgentActivitySessionSettings
} from "@tutti-os/agent-activity-core";

export {
  composerSettingsSupportFromOptions,
  type AgentComposerSettingsSupport
} from "./agent-gui/agentGuiNode/model/composerSettingsSupport.ts";

/**
 * Resolves the settings that a renderer should present without copying
 * provider defaults into a Mobile-specific model. Session facts win; a
 * pre-session composer uses the daemon-projected effective defaults.
 */
export function resolvePresentedAgentComposerSettings(input: {
  composerOptions: AgentActivityComposerOptions | null;
  settings?: AgentActivitySessionSettings | null;
  session: Pick<AgentActivitySession, "settings"> | null;
}): AgentActivitySessionSettings {
  const defaults = input.composerOptions?.effectiveSettings;
  const sessionSettings = input.session?.settings ?? input.settings;
  return {
    model: sessionSettings?.model ?? defaults?.model ?? null,
    permissionModeId:
      sessionSettings?.permissionModeId ?? defaults?.permissionModeId ?? null,
    planMode: sessionSettings?.planMode ?? defaults?.planMode ?? null,
    reasoningEffort:
      sessionSettings?.reasoningEffort ?? defaults?.reasoningEffort ?? null,
    speed: sessionSettings?.speed ?? defaults?.speed ?? null
  };
}
