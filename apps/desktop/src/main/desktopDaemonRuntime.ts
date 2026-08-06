import {
  createTuttidClient,
  type TuttidClient
} from "@tutti-os/client-tuttid-ts";
import {
  createTuttidManager,
  type TuttidManager
} from "./daemon/tuttidManager";
import { createDesktopDaemonFetch } from "./transport/fetch";
import {
  resolveDesktopDaemonEndpoint,
  type DesktopDaemonEndpoint
} from "./transport/paths";

export interface DesktopDaemonRuntime {
  daemonEndpoint: DesktopDaemonEndpoint;
  tuttid: TuttidManager;
  tuttidClient: TuttidClient;
}

export interface DesktopUpdateAdmissionDaemonConfig {
  managed: boolean;
  packaged: boolean;
  currentVersion: string;
  platform: "linux" | "macos" | "windows";
  architecture: "arm64" | "x64";
}

export function createDesktopDaemonRuntime(options?: {
  desktopUpdateAdmission?: DesktopUpdateAdmissionDaemonConfig;
  workspaceAppCliPath?: string;
}): DesktopDaemonRuntime {
  const daemonEndpoint = resolveDesktopDaemonEndpoint();
  const tuttidClient = createTuttidClient({
    auth: daemonEndpoint.accessToken,
    fetch: createDesktopDaemonFetch(() => daemonEndpoint)
  });
  const tuttid = createTuttidManager(daemonEndpoint, tuttidClient, {
    desktopUpdateAdmission: options?.desktopUpdateAdmission,
    workspaceAppCliPath: options?.workspaceAppCliPath
  });

  return {
    daemonEndpoint,
    tuttid,
    tuttidClient
  };
}
