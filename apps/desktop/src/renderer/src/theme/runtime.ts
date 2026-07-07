import {
  defaultDesktopThemeSource,
  type DesktopThemeSource,
  type DesktopThemeAppearance,
  type DesktopThemeState
} from "../../../shared/theme/index.ts";

function readInitialThemeAppearance(): DesktopThemeAppearance {
  return resolveWindowThemeAppearance();
}

function resolveWindowThemeAppearance(): DesktopThemeAppearance {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }

  return "light";
}

let activeTheme: DesktopThemeState = {
  appearance: readInitialThemeAppearanceFromLocation(),
  source: readInitialThemeSourceFromLocation()
};

syncDocumentTheme(activeTheme);

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleChange = () => {
    if (activeTheme.source !== "system") {
      return;
    }

    setActiveTheme(resolveDesktopThemeState("system"));
  };

  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", handleChange);
  } else if (typeof mediaQuery.addListener === "function") {
    mediaQuery.addListener(handleChange);
  }
}

export interface DesktopThemeSourceApi {
  getTheme(): Promise<DesktopThemeState>;
  onThemeChanged(listener: (theme: DesktopThemeState) => void): () => void;
}

export function syncDocumentTheme(theme: DesktopThemeState): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.theme = theme.appearance;
  document.documentElement.dataset.themeSource = theme.source;
  document.documentElement.style.colorScheme = theme.appearance;
}

function setActiveTheme(theme: DesktopThemeState): void {
  if (
    activeTheme.source === theme.source &&
    activeTheme.appearance === theme.appearance
  ) {
    return;
  }

  activeTheme = theme;
  syncDocumentTheme(theme);
}

export function getActiveTheme(): DesktopThemeState {
  return activeTheme;
}

export function resolveDesktopThemeState(
  source: DesktopThemeSource
): DesktopThemeState {
  return {
    appearance:
      source === "dark"
        ? "dark"
        : source === "light"
          ? "light"
          : resolveWindowThemeAppearance(),
    source
  };
}

function readInitialThemeSourceFromLocation(): DesktopThemeSource {
  if (typeof window === "undefined") {
    return defaultDesktopThemeSource;
  }

  const source = new URLSearchParams(window.location.search).get("themeSource");
  return isThemeSource(source) ? source : defaultDesktopThemeSource;
}

function readInitialThemeAppearanceFromLocation(): DesktopThemeAppearance {
  const source = readInitialThemeSourceFromLocation();
  if (source === "dark" || source === "light") {
    return source;
  }

  if (typeof window !== "undefined") {
    const appearance = new URLSearchParams(window.location.search).get("theme");
    if (isThemeAppearance(appearance)) {
      return appearance;
    }
  }

  return readInitialThemeAppearance();
}

function isThemeSource(value: string | null): value is DesktopThemeSource {
  return value === "system" || value === "dark" || value === "light";
}

function isThemeAppearance(
  value: string | null
): value is DesktopThemeAppearance {
  return value === "dark" || value === "light";
}

export function applyTheme(theme: DesktopThemeState): void {
  setActiveTheme(theme);
}

export function connectDesktopThemeSource(
  themeSource: DesktopThemeSourceApi
): () => void {
  let disposed = false;
  let themeEventVersion = 0;
  const unsubscribe = themeSource.onThemeChanged((theme) => {
    if (!disposed) {
      themeEventVersion += 1;
      applyTheme(theme);
    }
  });
  const initialThemeEventVersion = themeEventVersion;

  void themeSource.getTheme().then(
    (theme) => {
      if (!disposed && themeEventVersion === initialThemeEventVersion) {
        applyTheme(theme);
      }
    },
    () => {}
  );

  return () => {
    disposed = true;
    unsubscribe();
  };
}
