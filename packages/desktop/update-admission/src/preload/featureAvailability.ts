import type {
  DesktopFeatureAvailabilityApi,
  DesktopFeatureAvailabilitySnapshot
} from "../contracts/index.ts";
import { desktopFeatureAvailabilityIpcChannels } from "../contracts/featureAvailabilityIpc.ts";

export function createDesktopFeatureAvailabilityApi(input: {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
  on(
    channel: string,
    listener: (
      event: unknown,
      snapshot: DesktopFeatureAvailabilitySnapshot
    ) => void
  ): void;
  removeListener(
    channel: string,
    listener: (
      event: unknown,
      snapshot: DesktopFeatureAvailabilitySnapshot
    ) => void
  ): void;
}): DesktopFeatureAvailabilityApi {
  return {
    getSnapshot: () =>
      input.invoke<DesktopFeatureAvailabilitySnapshot>(
        desktopFeatureAvailabilityIpcChannels.getSnapshot
      ),
    isSupported: (key) =>
      input.invoke<boolean>(
        desktopFeatureAvailabilityIpcChannels.isSupported,
        key
      ),
    onChanged(listener) {
      const handler = (
        _event: unknown,
        snapshot: DesktopFeatureAvailabilitySnapshot
      ): void => listener(snapshot);
      input.on(desktopFeatureAvailabilityIpcChannels.changed, handler);
      return () =>
        input.removeListener(
          desktopFeatureAvailabilityIpcChannels.changed,
          handler
        );
    }
  };
}
