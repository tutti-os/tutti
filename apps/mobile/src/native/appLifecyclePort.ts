import type { AppLifecyclePort } from "../services/servicePorts";

export const APP_LIFECYCLE_EVENT_NAME = "TuttiAppLifecycleChanged";

export interface AppLifecycleNative {
  addListener(eventName: string): void;
  isForeground(): boolean;
  removeListeners(count: number): void;
}

export interface AppLifecycleEventSource {
  addListener(
    eventName: string,
    listener: (foreground: boolean) => void
  ): { remove(): void };
}

export function createAppLifecyclePort(
  nativeLifecycle: AppLifecycleNative,
  events: AppLifecycleEventSource
): AppLifecyclePort {
  return {
    subscribe(listener) {
      let lastForeground: boolean | undefined;
      const publish = (foreground: boolean) => {
        if (foreground === lastForeground) return;
        lastForeground = foreground;
        listener(foreground ? "foreground" : "background");
      };
      const subscription = events.addListener(
        APP_LIFECYCLE_EVENT_NAME,
        publish
      );
      publish(nativeLifecycle.isForeground());
      return () => subscription.remove();
    }
  };
}
