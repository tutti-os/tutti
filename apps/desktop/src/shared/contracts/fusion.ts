export const desktopFusionWindowKinds = [
  "agent",
  "terminal",
  "browser",
  "files",
  "file-preview",
  "workspace-app",
  "app-center",
  "settings",
  "issue-manager"
] as const;

export const desktopFusionDockLayout = {
  collapsedWindowWidthPx: 88,
  heightPx: 520,
  launcherRailWidthPx: 70,
  panelBorderWidthPx: 1,
  panelWidthPx: 72,
  searchWindowWidthPx: 420,
  windowInsetPx: 8
} as const;

export type DesktopFusionWindowKind = (typeof desktopFusionWindowKinds)[number];

export type DesktopFusionWindowVisibility = "hidden" | "minimized" | "visible";

export type DesktopFusionShortcutError = "conflict" | "invalid" | "unsupported";

export type DesktopFusionDockSearchScope = "all" | "background-tasks";

/**
 * Native-window creation request. `launchPayload` is the existing typed
 * Workbench contribution payload carried opaquely through Electron main;
 * renderer contribution code remains responsible for interpreting it.
 */
export interface DesktopFusionOpenWindowInput {
  forceNew?: boolean;
  kind: DesktopFusionWindowKind;
  launchPayload?: unknown;
  resourceId?: string | null;
  title?: string | null;
  workspaceId: string;
}

export interface DesktopFusionWindowTargetInput {
  windowInstanceId: string;
}

export interface DesktopFusionUpdateWindowInput extends DesktopFusionWindowTargetInput {
  resourceId?: string | null;
  title?: string | null;
}

export interface DesktopFusionWindowDescriptor {
  createdAtUnixMs: number;
  focused: boolean;
  kind: DesktopFusionWindowKind;
  lastFocusedAtUnixMs: number;
  resourceId: string | null;
  title: string | null;
  visibility: DesktopFusionWindowVisibility;
  windowInstanceId: string;
  workspaceId: string;
}

export interface DesktopFusionState {
  active: boolean;
  dockSearchExpanded: boolean;
  dockSearchScope: DesktopFusionDockSearchScope;
  dockVisible: boolean;
  revision: number;
  shortcut: {
    binding: string | null;
    error: DesktopFusionShortcutError | null;
  };
  windows: readonly DesktopFusionWindowDescriptor[];
  workspaceId: string | null;
}

export function isDesktopFusionWindowKind(
  value: unknown
): value is DesktopFusionWindowKind {
  return (
    typeof value === "string" &&
    desktopFusionWindowKinds.includes(value as DesktopFusionWindowKind)
  );
}
