import { DesktopCaptureWindowController } from "./desktopCaptureWindowController.ts";
import {
  createDesktopCaptureAgentTargetPreference,
  resolveDesktopCapturePreferenceStorage
} from "./desktopCaptureAgentTargetPreference.ts";
import { createDesktopCaptureProjectPreference } from "./desktopCaptureProjectPreference.ts";

export interface DesktopCaptureWindowContainer {
  controller: DesktopCaptureWindowController;
}

export function createDesktopCaptureWindowContainer(): DesktopCaptureWindowContainer {
  if (!window.tuttiCapture) {
    throw new Error("capture preload bridge is unavailable");
  }
  const preferenceStorage = resolveDesktopCapturePreferenceStorage();
  return {
    controller: new DesktopCaptureWindowController(
      window.tuttiCapture,
      createDesktopCaptureAgentTargetPreference(preferenceStorage),
      createDesktopCaptureProjectPreference(preferenceStorage)
    )
  };
}
