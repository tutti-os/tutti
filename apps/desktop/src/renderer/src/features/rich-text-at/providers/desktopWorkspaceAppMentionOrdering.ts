export interface DesktopWorkspaceAppMentionOrderItem {
  readonly appId: string;
  readonly displayName: string;
}

const workspaceAppMentionRankGroups = [
  ["ai-media-canvas", "media-canvas"],
  ["vibe-design"],
  ["group-chat"],
  ["automation"],
  ["daily-product-radar", "daily-tech-radar", "radar"],
  ["ai-slide"],
  ["ai-doc"],
  ["ai-sheet"],
  ["open-cut"],
  ["product-competition"],
  ["design-review"],
  ["draw-topic-app", "answer-book", "app_answer_book", "idea-draw"],
  ["calendar"]
] as const;

const workspaceAppMentionRankById = buildWorkspaceAppMentionRankById();

export function compareDesktopWorkspaceAppMentionItems(
  left: DesktopWorkspaceAppMentionOrderItem,
  right: DesktopWorkspaceAppMentionOrderItem,
  locale?: string
): number {
  const rankOrder =
    getWorkspaceAppMentionRank(left.appId) -
    getWorkspaceAppMentionRank(right.appId);
  if (rankOrder !== 0) {
    return rankOrder;
  }

  const nameOrder = left.displayName.localeCompare(right.displayName, locale, {
    sensitivity: "base"
  });
  if (nameOrder !== 0) {
    return nameOrder;
  }

  return left.appId.localeCompare(right.appId);
}

function getWorkspaceAppMentionRank(appId: string): number {
  return (
    workspaceAppMentionRankById.get(appId.trim().toLowerCase()) ??
    Number.MAX_SAFE_INTEGER
  );
}

function buildWorkspaceAppMentionRankById(): Map<string, number> {
  const rankById = new Map<string, number>();
  let rank = 0;

  for (const aliases of workspaceAppMentionRankGroups) {
    for (const appId of aliases) {
      rankById.set(appId, rank);
    }
    rank += 1;
  }

  return rankById;
}
