import type {
  DesktopFusionDockSearchScope,
  DesktopFusionOpenWindowInput,
  DesktopFusionState,
  DesktopFusionUpdateWindowInput,
  DesktopFusionWindowDescriptor,
  DesktopFusionWindowTargetInput
} from "../../shared/contracts/fusion.ts";
import type { DesktopLocale } from "../../shared/i18n/index.ts";
import type { DesktopDockPlacement } from "../../shared/preferences/index.ts";
import type { DesktopThemeState } from "../../shared/theme/index.ts";
import type { DesktopLogger } from "../logging.ts";

export type FusionDockVisibilityMode = "always" | "auto-hide" | "shortcut-only";

export type DesktopFusionRendererAccessContext =
  | { kind: "dock"; workspaceId: string }
  | {
      kind: "window";
      windowInstanceId: string;
      workspaceId: string;
    };

export interface DesktopFusionWindowCoordinator {
  activatePrimarySurface(): Promise<void>;
  closeWindow(input: DesktopFusionWindowTargetInput): Promise<void>;
  dispose(): void;
  focusWindow(input: DesktopFusionWindowTargetInput): Promise<void>;
  flushPersistentState(): Promise<void>;
  getRendererAccessContext(
    webContentsId: number
  ): DesktopFusionRendererAccessContext | null;
  getState(): DesktopFusionState;
  getStateForWorkspace(workspaceId: string): DesktopFusionState;
  getWindowDescriptor(
    windowInstanceId: string
  ): DesktopFusionWindowDescriptor | null;
  hideDock(): Promise<void>;
  isActive(): boolean;
  openWindow(
    input: DesktopFusionOpenWindowInput
  ): Promise<DesktopFusionWindowDescriptor>;
  showDock(): Promise<void>;
  showDockSearch(scope?: DesktopFusionDockSearchScope): Promise<void>;
  start(workspaceId: string): Promise<void>;
  toggleDock(): Promise<void>;
  updateWindow(
    input: DesktopFusionUpdateWindowInput
  ): Promise<DesktopFusionWindowDescriptor>;
}

export interface CreateFusionWindowCoordinatorOptions {
  active: boolean;
  browserNodeGuestPreloadPath?: string;
  enableDevelopmentReloadShortcut?: boolean;
  getDockPlacement(): DesktopDockPlacement;
  getDockVisibilityMode(): FusionDockVisibilityMode;
  getLocale(): DesktopLocale;
  getShortcutBinding(): string | null;
  getTheme(): DesktopThemeState;
  logger: DesktopLogger;
  preloadPath: string;
  rendererUrl?: string;
  subscribePreferences?(listener: () => void): () => void;
  trayIconPath?: string;
  userDataPath?: string;
  workspaceAppPreloadPath?: string;
}
