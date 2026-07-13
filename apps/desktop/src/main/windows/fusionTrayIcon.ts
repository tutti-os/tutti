import { join } from "node:path";

export const packagedFusionTrayIconName = "fusion-tray-icon.png";

export function resolveFusionTrayIconPath(input: {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
}): string {
  return input.isPackaged
    ? join(input.resourcesPath, packagedFusionTrayIconName)
    : join(input.appPath, "build", "icon.png");
}
