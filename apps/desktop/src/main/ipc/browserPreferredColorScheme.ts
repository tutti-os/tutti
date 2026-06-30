import type { DesktopThemeSource } from "../../shared/theme/index.ts";

export type BrowserPreferredColorScheme = "dark" | "light";

export const prefersColorSchemeFeatureName = "prefers-color-scheme";

export interface BrowserColorSchemeDebugger {
  isAttached(): boolean;
  attach(): void;
  detach(): void;
  sendCommand(command: string, params: unknown): Promise<unknown>;
}

export function resolveDesktopBrowserPreferredColorScheme(input: {
  nativeShouldUseDarkColors: boolean;
  themeSource: DesktopThemeSource;
}): BrowserPreferredColorScheme {
  if (input.themeSource === "dark" || input.themeSource === "light") {
    return input.themeSource;
  }

  return input.nativeShouldUseDarkColors ? "dark" : "light";
}

export async function syncPreferredColorSchemeViaDebugger(
  debuggerInstance: BrowserColorSchemeDebugger,
  scheme: BrowserPreferredColorScheme
): Promise<void> {
  const wasAttached = debuggerInstance.isAttached();
  if (!wasAttached) {
    debuggerInstance.attach();
  }

  try {
    await debuggerInstance.sendCommand("Emulation.setEmulatedMedia", {
      features: [
        {
          name: prefersColorSchemeFeatureName,
          value: scheme
        }
      ]
    });
  } catch (error) {
    if (!wasAttached && debuggerInstance.isAttached()) {
      debuggerInstance.detach();
    }
    throw error;
  }
}
