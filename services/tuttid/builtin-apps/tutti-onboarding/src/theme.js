export function readQueryTheme(
  host = typeof window !== "undefined" ? window : {}
) {
  if (!import.meta.env.DEV) return null;

  const search = host.location?.search;
  if (!search) return null;

  const theme = new URLSearchParams(search).get("theme");
  return theme === "light" || theme === "dark" ? theme : null;
}

export function applyDocumentTheme(theme) {
  if (typeof document === "undefined" || !theme) return;

  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}
