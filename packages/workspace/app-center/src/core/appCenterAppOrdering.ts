import type { AppCenterViewModel } from "../contracts/viewModel.ts";

const installableRecommendedAppIds = [
  ["ai-media-canvas", "media-canvas"],
  ["vibe-design"],
  ["group-chat"],
  ["automation"],
  ["daily-product-radar", "daily-tech-radar", "radar"]
] as const;

const comingSoonRecommendedAppIds = [
  "ai-ppt",
  "ai-document",
  "ai-sheet",
  "open-cut",
  "product-competition",
  "design-review",
  "calendar",
  "document-summarizer"
] as const;

const recommendedAppDisplayRankById = buildRecommendedAppDisplayRankById();

export function sortMyAppsByCreatedDesc(
  apps: readonly AppCenterViewModel["apps"][number][]
): AppCenterViewModel["apps"] {
  return [...apps].sort((left, right) => {
    const createdOrder =
      (right.createdAtUnixMs ?? 0) - (left.createdAtUnixMs ?? 0);
    if (createdOrder !== 0) {
      return createdOrder;
    }
    const nameOrder = left.name.localeCompare(right.name);
    if (nameOrder !== 0) {
      return nameOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

export function sortRecommendedApps(
  apps: readonly AppCenterViewModel["apps"][number][]
): AppCenterViewModel["apps"] {
  return [...apps].sort(compareRecommendedApps);
}

export function sortRecommendedAppsForAllTab(
  apps: readonly AppCenterViewModel["apps"][number][]
): AppCenterViewModel["apps"] {
  return [...apps].sort(compareRecommendedApps);
}

function compareRecommendedApps(
  left: AppCenterViewModel["apps"][number],
  right: AppCenterViewModel["apps"][number]
): number {
  const sectionOrder =
    getRecommendedAppSectionRank(left) - getRecommendedAppSectionRank(right);
  if (sectionOrder !== 0) {
    return sectionOrder;
  }

  const displayOrder =
    getRecommendedAppDisplayRank(left.id) -
    getRecommendedAppDisplayRank(right.id);
  if (displayOrder !== 0) {
    return displayOrder;
  }

  const comingSoonOrder =
    getRecommendedAppComingSoonRank(left) -
    getRecommendedAppComingSoonRank(right);
  if (comingSoonOrder !== 0) {
    return comingSoonOrder;
  }

  return left.name.localeCompare(right.name);
}

function buildRecommendedAppDisplayRankById(): Map<string, number> {
  const rankById = new Map<string, number>();
  let rank = 0;

  for (const aliases of installableRecommendedAppIds) {
    for (const appId of aliases) {
      rankById.set(appId, rank);
    }
    rank += 1;
  }

  for (const appId of comingSoonRecommendedAppIds) {
    rankById.set(appId, rank);
    rank += 1;
  }

  return rankById;
}

function getRecommendedAppDisplayRank(appId: string): number {
  return (
    recommendedAppDisplayRankById.get(appId.trim().toLowerCase()) ??
    Number.MAX_SAFE_INTEGER
  );
}

function getRecommendedAppSectionRank(
  app: AppCenterViewModel["apps"][number]
): number {
  const normalizedAppId = app.id.trim().toLowerCase();
  if (recommendedAppDisplayRankById.has(normalizedAppId)) {
    return isConfiguredComingSoonApp(normalizedAppId) ? 1 : 0;
  }

  return getRecommendedAppComingSoonRank(app);
}

function isConfiguredComingSoonApp(appId: string): boolean {
  return comingSoonRecommendedAppIds.some(
    (configuredAppId) => configuredAppId === appId
  );
}

function getRecommendedAppComingSoonRank(
  app: AppCenterViewModel["apps"][number]
): number {
  return app.statusLabelKey === "status.comingSoon" ||
    app.tags.some((tag) => tag.trim().toLowerCase() === "coming-soon")
    ? 1
    : 0;
}
