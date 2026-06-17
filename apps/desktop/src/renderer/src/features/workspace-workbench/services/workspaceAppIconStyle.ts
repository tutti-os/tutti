const defaultClaudeCodeIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/claudecode.png",
  import.meta.url
).href;
const defaultCodexIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/codex.png",
  import.meta.url
).href;
const defaultAiPptIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/PPT.png",
  import.meta.url
).href;
const defaultAiSummaryIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/aisummary.png",
  import.meta.url
).href;
const defaultCalendarIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/calendar.png",
  import.meta.url
).href;
const defaultDesignReviewIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/design-review.png",
  import.meta.url
).href;
const defaultDocumentIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/document.png",
  import.meta.url
).href;
const defaultMediaCanvasIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/mediacanvas.png",
  import.meta.url
).href;
const defaultOpenCutIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/opencut.png",
  import.meta.url
).href;
const defaultProductCompetitionIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/product-competition.png",
  import.meta.url
).href;
const defaultRadarIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/radar.png",
  import.meta.url
).href;
const defaultSheetIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/sheet.png",
  import.meta.url
).href;

export type WorkspaceAppIconResolver = (appId: string) => string | null;

export function createDefaultWorkspaceAppIconResolver(): WorkspaceAppIconResolver {
  const iconsByAppId = new Map<string, string>([
    ["agent-claude-code", defaultClaudeCodeIconUrl],
    ["agent-codex", defaultCodexIconUrl],
    ["ai-ppt", defaultAiPptIconUrl],
    ["ai-document", defaultDocumentIconUrl],
    ["ai-sheet", defaultSheetIconUrl],
    ["calendar", defaultCalendarIconUrl],
    ["design-review", defaultDesignReviewIconUrl],
    ["daily-product-radar", defaultRadarIconUrl],
    ["document-summarizer", defaultAiSummaryIconUrl],
    ["media-canvas", defaultMediaCanvasIconUrl],
    ["open-cut", defaultOpenCutIconUrl],
    ["product-competition", defaultProductCompetitionIconUrl],
    ["radar", defaultRadarIconUrl]
  ]);
  return (appId) => iconsByAppId.get(appId) ?? null;
}

export const nullWorkspaceAppIconResolver: WorkspaceAppIconResolver = () =>
  null;
