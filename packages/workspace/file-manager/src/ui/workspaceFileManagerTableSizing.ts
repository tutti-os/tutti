export const workspaceFileManagerTableNameMinWidth = 240;
export const workspaceFileManagerTableNameMinWidthProperty =
  "--workspace-file-manager-table-name-min-width";
export const workspaceFileManagerTableNameColumnSelector =
  "[data-workspace-file-manager-name-column]";

const workspaceFileManagerTableNameMinWidthExpression = `var(${workspaceFileManagerTableNameMinWidthProperty}, ${workspaceFileManagerTableNameMinWidth}px)`;

export const workspaceFileManagerTableGridClassName =
  "grid-cols-[minmax(240px,_1fr)_minmax(0,_148px)_minmax(0,_96px)]";
export const workspaceFileManagerTableGridTemplate = `minmax(${workspaceFileManagerTableNameMinWidthExpression}, 1fr) minmax(0, 148px) minmax(0, 96px)`;

export const workspaceFileManagerCompactTableGridClassName =
  "grid-cols-[minmax(240px,_1fr)_minmax(0,_96px)_minmax(0,_72px)]";
export const workspaceFileManagerCompactTableGridTemplate = `minmax(${workspaceFileManagerTableNameMinWidthExpression}, 1fr) minmax(0, 96px) minmax(0, 72px)`;

export function resolveWorkspaceFileManagerPreservedNameColumnWidth(
  width: number
): number {
  const resolvedWidth = Number.isFinite(width)
    ? Math.round(width)
    : workspaceFileManagerTableNameMinWidth;
  return Math.max(workspaceFileManagerTableNameMinWidth, resolvedWidth);
}
