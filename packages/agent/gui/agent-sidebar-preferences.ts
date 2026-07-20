// Narrow subpath so hosts (apps/desktop) can read and write the Agent Sidebar
// display setting from the SAME device-global source the provider rail uses.
// This is the single source of truth for which agents appear in the sidebar;
// consumers must not re-implement the storage key or serialization.
export {
  AGENT_GUI_PROVIDER_RAIL_PREFERENCES_STORAGE_KEY,
  changeAgentGUIProviderManagerVisibility,
  normalizeAgentGUIProviderRailHiddenTargetIds,
  type AgentGUIProviderRailPreferences
} from "./agent-gui/agentGuiNode/model/agentGuiProviderRailOrder.ts";
export { useAgentGUIProviderRailPreferences } from "./agent-gui/agentGuiNode/view/useAgentGUIProviderRailPreferences.ts";
