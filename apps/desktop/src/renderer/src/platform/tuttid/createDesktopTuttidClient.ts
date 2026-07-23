import {
  createTuttidClient,
  type MobileRemoteAccessClient,
  type TuttidClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";
import { createRestartAwareFetch } from "./createRestartAwareFetch.ts";

export function createDesktopTuttidClient(
  runtimeApi: DesktopRuntimeApi
): TuttidClient & MobileRemoteAccessClient {
  return createTuttidClient({
    fetch: createRestartAwareFetch(runtimeApi)
  });
}
