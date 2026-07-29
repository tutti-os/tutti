import { existsSync } from "node:fs";
import { join } from "node:path";
import { tuttiAssetProtocolScheme } from "../../shared/tuttiAssetProtocol.ts";
import {
  tuttiAssetProtocolAssets,
  type TuttiAssetProtocolRoute
} from "./tuttiAssetProtocolAssets.ts";

export function resolveTuttiAssetProtocolFilePath(
  url: string,
  appPath: string
): string | null {
  const route = tuttiAssetRouteFromUrl(url);
  if (!route) {
    return null;
  }

  const sourcePath = join(appPath, tuttiAssetProtocolAssets[route]);
  if (existsSync(sourcePath)) {
    return sourcePath;
  }

  const builtAssetPath = join(
    appPath,
    "out",
    "renderer",
    "assets",
    "tutti-asset",
    route
  );
  return existsSync(builtAssetPath) ? builtAssetPath : null;
}

function tuttiAssetRouteFromUrl(value: string): TuttiAssetProtocolRoute | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== `${tuttiAssetProtocolScheme}:`) {
    return null;
  }
  const key = `${url.hostname}${url.pathname}`.replace(/^\/+/, "");
  return key in tuttiAssetProtocolAssets
    ? (key as TuttiAssetProtocolRoute)
    : null;
}
