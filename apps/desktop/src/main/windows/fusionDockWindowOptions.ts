import type { BrowserWindowConstructorOptions } from "electron";

export interface FusionDockWindowOptionsInput {
  bounds: { height: number; width: number; x: number; y: number };
  preloadPath: string;
}

export function createFusionDockWindowOptions(
  input: FusionDockWindowOptionsInput
): BrowserWindowConstructorOptions {
  return {
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    frame: false,
    fullscreenable: false,
    // The renderer owns the inset glass surface and its elevation. A native
    // shadow follows the full transparent BrowserWindow bounds instead, which
    // creates a second rounded frame around the visible Dock.
    hasShadow: false,
    height: input.bounds.height,
    maximizable: false,
    minimizable: false,
    movable: true,
    resizable: false,
    roundedCorners: true,
    show: false,
    skipTaskbar: true,
    transparent: true,
    width: input.bounds.width,
    x: input.bounds.x,
    y: input.bounds.y,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: input.preloadPath,
      sandbox: false
    }
  };
}
