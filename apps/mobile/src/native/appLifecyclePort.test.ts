import {
  APP_LIFECYCLE_EVENT_NAME,
  createAppLifecyclePort,
  type AppLifecycleEventSource,
  type AppLifecycleNative
} from "./appLifecyclePort";
import type { AppLifecycleState } from "../services/servicePorts";

describe("createAppLifecyclePort", () => {
  test("publishes the current process state and deduplicates native events", () => {
    const harness = createHarness(true);
    const states: AppLifecycleState[] = [];

    const dispose = createAppLifecyclePort(
      harness.nativeLifecycle,
      harness.events
    ).subscribe((active) => states.push(active));

    harness.emit(false);
    harness.emit(false);
    harness.emit(true);
    expect(states).toEqual(["foreground", "background", "foreground"]);

    dispose();
    harness.emit(false);
    expect(states).toEqual(["foreground", "background", "foreground"]);
  });
});

function createHarness(initialActive: boolean): {
  emit(active: boolean): void;
  events: AppLifecycleEventSource;
  nativeLifecycle: AppLifecycleNative;
} {
  let listener: ((active: boolean) => void) | null = null;
  return {
    emit(active) {
      listener?.(active);
    },
    events: {
      addListener(eventName, nextListener) {
        expect(eventName).toBe(APP_LIFECYCLE_EVENT_NAME);
        listener = nextListener;
        return {
          remove() {
            listener = null;
          }
        };
      }
    },
    nativeLifecycle: {
      addListener() {},
      isForeground: () => initialActive,
      removeListeners() {}
    }
  };
}
