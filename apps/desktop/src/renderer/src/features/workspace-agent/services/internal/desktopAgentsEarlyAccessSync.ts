import { subscribe } from "valtio";
import type { DesktopFeatureFlags } from "@shared/preferences";
import {
  EARLY_ACCESS_AGENT_INTEGRATIONS_FLAG,
  isFeatureEnabled
} from "../../../../../../shared/featureFlags/catalog.ts";

export interface DesktopAgentsEarlyAccessSyncTarget {
  setEarlyAccessEnabled(enabled: boolean): void;
}

export interface DesktopAgentsEarlyAccessPreferencesStore {
  readonly featureFlags: DesktopFeatureFlags;
}

/**
 * Keeps the global Agents directory in sync with the single Early Access
 * preference. The settings tab renders its own local view, but the launcher,
 * sidebar, and mention pickers all consume the service's filtered `agents`
 * list, so the visibility rule must live on the service — not be recomputed per
 * surface. This binds the daemon-owned agents service to the device-global
 * `lab.previewAgents` flag: it seeds the current value and reapplies it whenever
 * the preference store changes (from settings, deep link, or another window).
 *
 * setEarlyAccessEnabled is idempotent, so subscribing to the whole preferences
 * store is safe: unrelated preference changes resolve to the same value and
 * no-op.
 */
export function bindDesktopAgentsEarlyAccessSync(input: {
  agentsService: DesktopAgentsEarlyAccessSyncTarget;
  preferencesStore: DesktopAgentsEarlyAccessPreferencesStore;
}): () => void {
  const applyEarlyAccessVisibility = (): void => {
    input.agentsService.setEarlyAccessEnabled(
      isFeatureEnabled(
        input.preferencesStore.featureFlags,
        EARLY_ACCESS_AGENT_INTEGRATIONS_FLAG
      )
    );
  };
  applyEarlyAccessVisibility();
  return subscribe(input.preferencesStore, applyEarlyAccessVisibility);
}
