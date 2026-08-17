import { useCallback } from "react";
import type { DesktopRuntimeApi } from "@preload/types";
import type { IDesktopPreferencesService } from "@renderer/features/desktop-preferences/services/desktopPreferencesService.interface.ts";
import type { DesktopAgentSessionLaunchMode } from "@shared/preferences";
import { logAgentGUISessionLaunchModePreferenceDiagnostic } from "./desktopAgentGUIWorkbenchDiagnostics.ts";

interface DesktopAgentGUISessionLaunchModePreferenceInput {
  desktopPreferencesService: Pick<
    IDesktopPreferencesService,
    "rememberAgentSessionLaunchMode"
  >;
  runtimeApi?: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  workspaceId: string;
}

export function rememberDesktopAgentGUISessionLaunchModePreference(
  input: DesktopAgentGUISessionLaunchModePreferenceInput & {
    mode: DesktopAgentSessionLaunchMode;
    projectSectionKey: string;
  }
): Promise<void> {
  return input.desktopPreferencesService
    .rememberAgentSessionLaunchMode(
      input.workspaceId,
      input.projectSectionKey,
      input.mode
    )
    .catch((error) => {
      logAgentGUISessionLaunchModePreferenceDiagnostic({
        error,
        mode: input.mode,
        projectSectionKey: input.projectSectionKey,
        runtimeApi: input.runtimeApi,
        workspaceId: input.workspaceId
      });
    });
}

export function useDesktopAgentGUISessionLaunchModePreference({
  desktopPreferencesService,
  runtimeApi,
  workspaceId
}: DesktopAgentGUISessionLaunchModePreferenceInput): (input: {
  mode: DesktopAgentSessionLaunchMode;
  projectSectionKey: string;
}) => void {
  return useCallback(
    (input) => {
      void rememberDesktopAgentGUISessionLaunchModePreference({
        desktopPreferencesService,
        mode: input.mode,
        projectSectionKey: input.projectSectionKey,
        runtimeApi,
        workspaceId
      });
    },
    [desktopPreferencesService, runtimeApi, workspaceId]
  );
}
