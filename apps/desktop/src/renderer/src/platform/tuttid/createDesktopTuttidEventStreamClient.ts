import {
  createTuttidEventStreamClient,
  type TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";

export function createDesktopTuttidEventStreamClient(
  runtimeApi: DesktopRuntimeApi
): TuttidEventStreamClient {
  return createTuttidEventStreamClient({
    resolveUrl: () => runtimeApi.getBusinessEventStreamUrl(),
    // Frames that fail schema validation are dropped by the transport; the
    // drop must land in the desktop log or producer/schema drift is invisible
    // (a dropped state_patch reads as "the update never happened").
    onInvalidFrame: (error, context) => {
      void runtimeApi
        .logTerminalDiagnostic({
          details: { error: error.message, ready: context.ready },
          event: "agent.events.stream.invalid_frame",
          level: "warn"
        })
        .catch(() => {});
    }
  });
}
