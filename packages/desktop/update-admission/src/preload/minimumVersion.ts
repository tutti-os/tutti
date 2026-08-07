import type {
  DesktopMinimumVersionApi,
  MinimumVersionUpgradeState
} from "../contracts/index.ts";
import { desktopUpdateAdmissionIpcChannels } from "../contracts/updateAdmissionIpc.ts";

export function createDesktopMinimumVersionApi(input: {
  invoke<T>(channel: string): Promise<T>;
  on(
    channel: string,
    listener: (event: unknown, state: MinimumVersionUpgradeState) => void
  ): void;
  removeListener(
    channel: string,
    listener: (event: unknown, state: MinimumVersionUpgradeState) => void
  ): void;
}): DesktopMinimumVersionApi {
  return {
    getState: () =>
      input.invoke<MinimumVersionUpgradeState | null>(
        desktopUpdateAdmissionIpcChannels.getState
      ),
    start: () =>
      input.invoke<MinimumVersionUpgradeState | null>(
        desktopUpdateAdmissionIpcChannels.start
      ),
    retry: () =>
      input.invoke<MinimumVersionUpgradeState | null>(
        desktopUpdateAdmissionIpcChannels.retry
      ),
    later: () => input.invoke<void>(desktopUpdateAdmissionIpcChannels.later),
    openManualDownload: () =>
      input.invoke<void>(desktopUpdateAdmissionIpcChannels.manualDownload),
    exit: () => input.invoke<void>(desktopUpdateAdmissionIpcChannels.exit),
    restart: () =>
      input.invoke<void>(desktopUpdateAdmissionIpcChannels.restart),
    onState(listener) {
      const handler = (
        _event: unknown,
        state: MinimumVersionUpgradeState
      ): void => listener(state);
      input.on(desktopUpdateAdmissionIpcChannels.state, handler);
      return () =>
        input.removeListener(desktopUpdateAdmissionIpcChannels.state, handler);
    }
  };
}
