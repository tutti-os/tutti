import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import type { DesktopHostPreferencesState } from "../desktopHostPreferences.ts";
import { registerDesktopIpcHandler } from "./handle.ts";

export function registerHostPreferencesIpc(
  preferences: Pick<DesktopHostPreferencesState, "ensureInitialized">
): void {
  registerDesktopIpcHandler(
    desktopIpcChannels.host.preferences.ensureInitialized,
    () => preferences.ensureInitialized()
  );
}
