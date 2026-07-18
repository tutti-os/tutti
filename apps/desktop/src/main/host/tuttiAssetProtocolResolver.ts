import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tuttiAssetProtocolScheme } from "../../shared/tuttiAssetProtocol.ts";

const tuttiAssetRoutes = {
  "agent/claudecode.png": {
    builtFilePrefixes: ["claude-rounded-", "claudecode-"],
    sourceRelativePath:
      "src/renderer/src/assets/workspace-canvas/dock/default/claudecode.png"
  },
  "agent/codex.png": {
    builtFilePrefixes: ["codex-rounded-", "codex-"],
    sourceRelativePath:
      "src/renderer/src/assets/workspace-canvas/dock/default/codex.png"
  },
  "agent/cursor.png": {
    builtFilePrefixes: ["cursor-colorful-", "cursor-rounded-", "cursor-"],
    sourceRelativePath:
      "src/renderer/src/assets/workspace-canvas/dock/default/cursor.png"
  },
  "agent/hermes.png": {
    builtFilePrefixes: ["hermes-rounded-", "hermes-"],
    sourceRelativePath:
      "src/renderer/src/assets/workspace-canvas/dock/default/hermes.png"
  },
  "agent/openclaw.png": {
    builtFilePrefixes: ["openclaw-rounded-", "openclaw-"],
    sourceRelativePath:
      "src/renderer/src/assets/workspace-canvas/dock/default/openclaw.png"
  },
  "agent/opencode.png": {
    builtFilePrefixes: ["opencode-rounded-", "opencode-"],
    sourceRelativePath:
      "src/renderer/src/assets/workspace-canvas/dock/default/opencode.png"
  },
  "agent/tutti.png": {
    builtFilePrefixes: ["tutti-"],
    sourceRelativePath:
      "src/renderer/src/assets/workspace-canvas/dock/default/tutti.png"
  },
  "file/default.png": {
    builtFilePrefixes: ["document-"],
    sourceRelativePath:
      "src/renderer/src/assets/workspace-canvas/dock/default/apps/document.png"
  },
  "folder/default.png": {
    builtFilePrefixes: ["files-"],
    sourceRelativePath:
      "src/renderer/src/assets/workspace-canvas/dock/default/files.png"
  },
  "issue/default.png": {
    builtFilePrefixes: ["issue-"],
    sourceRelativePath:
      "src/renderer/src/assets/workspace-canvas/dock/default/issue.png"
  }
} as const;

export function resolveTuttiAssetProtocolFilePath(
  url: string,
  appPath: string
): string | null {
  const route = tuttiAssetRouteFromUrl(url);
  if (!route) {
    return null;
  }

  const sourcePath = join(appPath, route.sourceRelativePath);
  if (existsSync(sourcePath)) {
    return sourcePath;
  }

  const builtAssetsDirectory = join(appPath, "out", "renderer", "assets");
  if (!existsSync(builtAssetsDirectory)) {
    return null;
  }

  const builtFileName = readdirSync(builtAssetsDirectory).find(
    (fileName) =>
      route.builtFilePrefixes.some((prefix) => fileName.startsWith(prefix)) &&
      fileName.toLowerCase().endsWith(".png")
  );
  return builtFileName ? join(builtAssetsDirectory, builtFileName) : null;
}

function tuttiAssetRouteFromUrl(
  value: string
): (typeof tuttiAssetRoutes)[keyof typeof tuttiAssetRoutes] | null {
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
  return tuttiAssetRoutes[key as keyof typeof tuttiAssetRoutes] ?? null;
}
