export type AppCenterAppTab = "recommended" | "community" | "my";

const defaultVisibleAppTabs: readonly AppCenterAppTab[] = [
  "recommended",
  "community",
  "my"
];

export function resolveVisibleAppCenterTabs(
  configuredTabs: readonly AppCenterAppTab[] | undefined
): readonly AppCenterAppTab[] {
  if (configuredTabs === undefined) {
    return defaultVisibleAppTabs;
  }

  const visibleTabs = configuredTabs.filter(
    (tab, index) =>
      defaultVisibleAppTabs.includes(tab) &&
      configuredTabs.indexOf(tab) === index
  );
  return visibleTabs.length > 0 ? visibleTabs : ["recommended"];
}

export function resolveActiveAppCenterTab(
  requestedTab: AppCenterAppTab,
  visibleTabs: readonly AppCenterAppTab[]
): AppCenterAppTab {
  return visibleTabs.includes(requestedTab)
    ? requestedTab
    : (visibleTabs[0] ?? "recommended");
}
