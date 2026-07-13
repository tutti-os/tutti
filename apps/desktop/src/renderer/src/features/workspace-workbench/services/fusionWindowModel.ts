import type {
  DesktopFusionWindowDescriptor,
  DesktopFusionWindowKind
} from "@shared/contracts/fusion.ts";

const fusionWorkbenchTypeIds: Partial<
  Record<DesktopFusionWindowKind, readonly string[]>
> = {
  agent: ["agent-gui"],
  "app-center": ["workspace-app-center"],
  browser: ["browser"],
  "file-preview": ["workspace-image-file", "workspace-text-file"],
  files: ["workspace-files"],
  "issue-manager": ["issue-manager"],
  settings: ["settings", "workspace-settings"],
  terminal: ["workspace-terminal"],
  "workspace-app": ["workspace-app-webview"]
};

export function resolveFusionWorkbenchTypeId(input: {
  kind: DesktopFusionWindowKind;
  launchPayload?: unknown;
}): string | null {
  if (input.kind === "file-preview") {
    return readFilePreviewKind(input.launchPayload) === "image"
      ? "workspace-image-file"
      : "workspace-text-file";
  }
  return fusionWorkbenchTypeIds[input.kind]?.[0] ?? null;
}

export function resolveFusionKindForWorkbenchTypeId(
  typeId: string
): DesktopFusionWindowKind | null {
  for (const [kind, typeIds] of Object.entries(fusionWorkbenchTypeIds)) {
    if (typeIds?.includes(typeId)) {
      return kind as DesktopFusionWindowKind;
    }
  }
  return null;
}

export function resolveMostRecentFusionWindow(
  windows: readonly DesktopFusionWindowDescriptor[],
  kind: DesktopFusionWindowKind
): DesktopFusionWindowDescriptor | null {
  return (
    [...windows]
      .filter((window) => window.kind === kind)
      .sort(
        (left, right) =>
          right.lastFocusedAtUnixMs - left.lastFocusedAtUnixMs ||
          right.createdAtUnixMs - left.createdAtUnixMs
      )[0] ?? null
  );
}

export function createStandaloneWorkbenchNodeId(input: {
  instanceId: string;
  typeId: string;
}): string {
  return input.instanceId === input.typeId
    ? input.typeId
    : `${input.typeId}:${input.instanceId}`;
}

export function rendererRouteOwnsAgentOutcomeNotifications(
  routeView: string
): boolean {
  return routeView === "workspace";
}

function readFilePreviewKind(payload: unknown): "image" | "text" {
  if (!payload || typeof payload !== "object") {
    return "text";
  }
  return (payload as { fileKind?: unknown }).fileKind === "image"
    ? "image"
    : "text";
}
