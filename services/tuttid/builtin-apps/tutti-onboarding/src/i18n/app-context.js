import { useEffect, useState } from "react";

export const defaultLocale = "en-US";
export const supportedLocales = ["en-US", "zh-CN"];

function currentHost() {
  return typeof window === "undefined" ? {} : window;
}

function getExternalApp(host) {
  return host.tuttiExternal?.app;
}

export function normalizeLocale(value) {
  const tag = String(value || "")
    .trim()
    .replace(/_/g, "-");

  if (!tag) return defaultLocale;

  const exact = supportedLocales.find(
    (locale) => locale.toLowerCase() === tag.toLowerCase()
  );
  if (exact) return exact;

  const language = tag.split("-")[0].toLowerCase();
  return (
    supportedLocales.find(
      (locale) => locale.split("-")[0].toLowerCase() === language
    ) || defaultLocale
  );
}

export function readQueryLocale(host = currentHost()) {
  const search = host.location?.search;
  if (!search) return null;

  const params = new URLSearchParams(search);
  return params.get("locale") || params.get("lang");
}

export function resolveAppLocale(appLocale, hostLocale) {
  return appLocale ? normalizeLocale(appLocale) : normalizeLocale(hostLocale);
}

export async function readHostLocale(host = currentHost()) {
  const externalApp = getExternalApp(host);

  if (typeof externalApp?.getContext === "function") {
    const context = await externalApp.getContext();
    return normalizeLocale(context?.locale || context?.language);
  }

  return normalizeLocale(
    host.document?.documentElement?.lang ||
      host.navigator?.languages?.[0] ||
      host.navigator?.language
  );
}

export function subscribeHostLocale(listener, host = currentHost()) {
  const externalApp = getExternalApp(host);

  if (typeof externalApp?.subscribe === "function") {
    return externalApp.subscribe((context) => {
      const rawLocale = context?.locale ?? context?.language;
      if (!rawLocale) return;
      listener(normalizeLocale(rawLocale));
    });
  }

  return () => {};
}

export function useAppLocale() {
  const [locale, setLocale] = useState(() =>
    resolveAppLocale(
      import.meta.env.DEV ? readQueryLocale() : null,
      typeof navigator === "undefined" ? defaultLocale : navigator.language
    )
  );

  useEffect(() => {
    let isMounted = true;
    const queryLocale = import.meta.env.DEV ? readQueryLocale() : null;

    if (queryLocale) {
      setLocale(normalizeLocale(queryLocale));
      return () => {
        isMounted = false;
      };
    }

    void readHostLocale().then((nextLocale) => {
      if (isMounted) setLocale(nextLocale);
    });

    const unsubscribe = subscribeHostLocale((nextLocale) => {
      if (isMounted) setLocale(nextLocale);
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  return locale;
}
