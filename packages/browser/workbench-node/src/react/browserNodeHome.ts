export function isBrowserNodeHomeUrl(url: string | null | undefined): boolean {
  const normalized = url?.trim().toLowerCase() ?? "";
  return normalized.length === 0 || normalized === "about:blank";
}
