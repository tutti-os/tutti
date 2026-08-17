import type { NotificationService } from "@tutti-os/ui-notifications";
import type { DesktopFeatureFlags } from "@shared/preferences";
import { desktopFeatureFlagsEqual } from "../../../../../../shared/preferences/index.ts";
import {
  AGENT_EXTENSION_ACTIVATION_FLAGS,
  AGENT_QUICK_PROMPT_LIBRARY_FLAG,
  isFeatureEnabled
} from "../../../../../../shared/featureFlags/catalog.ts";
import type { IDesktopPreferencesService as DesktopPreferencesService } from "../../../desktop-preferences/services/desktopPreferencesService.interface.ts";
import { getActiveLocale } from "../../../../i18n/runtime.ts";
import { createTranslator } from "../../../../../../shared/i18n/index.ts";

export interface WorkspaceFeatureFlagSettings {
  change(flags: DesktopFeatureFlags): Promise<void>;
}

export function createWorkspaceFeatureFlagSettings(input: {
  desktopPreferences: Pick<
    DesktopPreferencesService,
    "setFeatureFlags" | "store"
  >;
  notifications: Pick<NotificationService, "error">;
  refreshAgentTargets: () => Promise<void>;
}): WorkspaceFeatureFlagSettings {
  return {
    async change(nextFlags) {
      const { changingFeatureFlags, featureFlags } =
        input.desktopPreferences.store;
      const previousFlags = changingFeatureFlags ?? featureFlags;
      if (
        desktopFeatureFlagsEqual(featureFlags, nextFlags) ||
        (changingFeatureFlags !== null &&
          desktopFeatureFlagsEqual(changingFeatureFlags, nextFlags))
      ) {
        return;
      }

      const quickPromptLibraryChanged =
        isFeatureEnabled(previousFlags, AGENT_QUICK_PROMPT_LIBRARY_FLAG) !==
        isFeatureEnabled(nextFlags, AGENT_QUICK_PROMPT_LIBRARY_FLAG);
      try {
        const activationChanged = AGENT_EXTENSION_ACTIVATION_FLAGS.some(
          (flag) =>
            isFeatureEnabled(previousFlags, flag) !==
            isFeatureEnabled(nextFlags, flag)
        );
        await input.desktopPreferences.setFeatureFlags(nextFlags);
        if (activationChanged) {
          await input.refreshAgentTargets();
        }
      } catch {
        input.notifications.error({
          title: createTranslator(getActiveLocale()).t(
            quickPromptLibraryChanged
              ? "workspace.settings.developer.quickPromptLibrarySaveFailed"
              : "workspace.settings.lab.preferencesSaveFailed"
          )
        });
      }
    }
  };
}
