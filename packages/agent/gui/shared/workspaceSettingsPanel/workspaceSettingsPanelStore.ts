import { useSnapshot } from "valtio";
import { proxy } from "valtio/vanilla";

/**
 * Deep-link intent to open the host's global workspace settings panel from
 * anywhere in the agent-gui tree (e.g. the conversation rail's "Usage &
 * Settings" popover). The host (apps/desktop) watches this singleton store and
 * opens its settings panel, navigating to `section` when provided.
 *
 * Workspace settings keeps this legacy request channel; Agent Env uses an
 * injected host command and a desktop-owned service instead
 * settings service; it only publishes the intent as a plain string section.
 */
export interface WorkspaceSettingsPanelRequest {
  /**
   * Which settings section to navigate to, e.g. "agent". Kept as a plain string
   * so agent-gui does not depend on the host's section id union; the host
   * validates/casts it.
   */
  section: string | null;
  /**
   * Optional sub-pane within the section, e.g. "agents" to open the Agents tab
   * of the agent section. Plain string; the host validates/casts it.
   */
  pane: string | null;
  /**
   * Optional provider/agent id to focus once the pane is open, e.g. deep-linking
   * from an agent's "more" action to its row in the Agents tab. Plain string.
   */
  provider: string | null;
  /**
   * Bumped on every openWorkspaceSettingsPanel() call so the host reacts even
   * when the panel is already open or the section is unchanged.
   */
  requestSequence: number;
}

export interface OpenWorkspaceSettingsPanelInput {
  section?: string | null;
  pane?: string | null;
  provider?: string | null;
}

const workspaceSettingsPanelStore = proxy<WorkspaceSettingsPanelRequest>({
  section: null,
  pane: null,
  provider: null,
  requestSequence: 0
});

/**
 * Request that the host open the global workspace settings panel. Safe to call
 * from anywhere in the agent-gui tree; the host renders the actual panel and
 * reacts to this singleton store.
 */
export function openWorkspaceSettingsPanel(
  input?: OpenWorkspaceSettingsPanelInput
): void {
  workspaceSettingsPanelStore.section = input?.section ?? null;
  workspaceSettingsPanelStore.pane = input?.pane ?? null;
  workspaceSettingsPanelStore.provider = input?.provider ?? null;
  workspaceSettingsPanelStore.requestSequence += 1;
}

/** Imperative read, mainly for tests. Components should use the hook. */
export function getWorkspaceSettingsPanelStore(): WorkspaceSettingsPanelRequest {
  return workspaceSettingsPanelStore;
}

/** Reactive snapshot of the panel request for the host renderer. */
export function useWorkspaceSettingsPanelRequest(): WorkspaceSettingsPanelRequest {
  return useSnapshot(workspaceSettingsPanelStore);
}
