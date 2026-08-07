import type { AppUpdateState } from "@shared/contracts/ipc";
import type { DesktopI18nKey, I18nParams } from "@shared/i18n";

export type AppUpdateViewAction = "download" | "install" | "retry";
export type AppUpdateViewIcon = "alert" | "loading" | "spark";
export type AppUpdateViewTone = "error" | "info";

export interface AppUpdateViewState {
  action: AppUpdateViewAction | null;
  actionKey: DesktopI18nKey | null;
  busy: boolean;
  icon: AppUpdateViewIcon;
  progressPercent: number | null;
  titleKey: DesktopI18nKey | null;
  titleParams?: I18nParams;
  tone: AppUpdateViewTone;
  visible: boolean;
}

export interface AppUpdateStoreState {
  error: string | null;
  isActing: boolean;
  supportsReleaseChannels: boolean;
  updateState: AppUpdateState | null;
  view: AppUpdateViewState;
}

export interface AppUpdateReadableStoreState {
  readonly error: string | null;
  readonly isActing: boolean;
  readonly supportsReleaseChannels: boolean;
  readonly updateState: AppUpdateState | null;
  readonly view: AppUpdateViewState;
}
