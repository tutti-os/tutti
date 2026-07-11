import {
  defaultDesktopLocale,
  resolveDesktopLocaleFromCandidates,
  toDocumentLanguage,
  type DesktopLocale
} from "../../../shared/i18n/index.ts";

const localeListeners = new Set<(locale: DesktopLocale) => void>();

function readInitialLocale(): DesktopLocale {
  if (typeof window === "undefined") {
    return defaultDesktopLocale;
  }

  const searchParams = new URLSearchParams(window.location.search);
  const queryLocale = searchParams.get("lang");

  return resolveDesktopLocaleFromCandidates([
    queryLocale,
    ...(navigator.languages ?? []),
    navigator.language
  ]);
}

let activeLocale: DesktopLocale = readInitialLocale();

export interface DesktopLocaleSource {
  getLocale(): Promise<DesktopLocale>;
  onLocaleChanged(listener: (locale: DesktopLocale) => void): () => void;
}

export function syncDocumentLanguage(locale: DesktopLocale): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.lang = toDocumentLanguage(locale);
}

// Keep the shared DOM locale authoritative before React effects or preload
// request handlers can observe the static index.html fallback.
syncDocumentLanguage(activeLocale);

function setActiveLocale(locale: DesktopLocale): void {
  if (activeLocale === locale) {
    return;
  }

  activeLocale = locale;
  syncDocumentLanguage(locale);
  localeListeners.forEach((listener) => {
    listener(locale);
  });
}

export function subscribeLocale(
  listener: (locale: DesktopLocale) => void
): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

export function getActiveLocale(): DesktopLocale {
  return activeLocale;
}

export function applyLocale(locale: DesktopLocale): void {
  setActiveLocale(locale);
}

export function connectDesktopLocaleSource(
  localeSource: DesktopLocaleSource
): () => void {
  let disposed = false;
  let localeEventVersion = 0;
  const unsubscribe = localeSource.onLocaleChanged((locale) => {
    if (!disposed) {
      localeEventVersion += 1;
      applyLocale(locale);
    }
  });
  const initialLocaleEventVersion = localeEventVersion;

  void localeSource.getLocale().then(
    (locale) => {
      if (!disposed && localeEventVersion === initialLocaleEventVersion) {
        applyLocale(locale);
      }
    },
    () => {}
  );

  return () => {
    disposed = true;
    unsubscribe();
  };
}
