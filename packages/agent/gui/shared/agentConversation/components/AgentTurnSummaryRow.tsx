import { useMemo, useState, type JSX } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DirectLinedIcon } from "../../../app/renderer/components/icons/DirectLinedIcon";
import { translate } from "../../../i18n/index";
import type { WorkspaceLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import { resolveWorkspaceFileLinkAction } from "../../../contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import { CanvasNodeGhostIconButton } from "../../../contexts/workspace/presentation/renderer/components/shared/CanvasNodeGhostIconButton";
import type {
  AgentTurnSummaryFileVM,
  AgentTurnSummaryRowVM
} from "../contracts/agentTurnSummaryRowVM";
import { AgentCodeBlock } from "./tool-renderers/code/AgentCodeBlock";
import { CollapsibleReveal } from "./CollapsibleReveal";
import { AgentMonacoDiffViewer } from "./tool-renderers/file-diff/AgentMonacoDiffViewer";
import { parseAgentUnifiedDiffStats } from "./tool-renderers/file-diff/agentUnifiedDiff";
import { AgentUnifiedPatchViewer } from "./tool-renderers/file-diff/AgentUnifiedPatchViewer";

interface AgentTurnSummaryRowProps {
  row: AgentTurnSummaryRowVM;
  workspaceRoot?: string | null;
  label: string;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  previewMode?: boolean;
}

export function AgentTurnSummaryRow({
  row,
  workspaceRoot,
  onLinkAction
}: AgentTurnSummaryRowProps): JSX.Element {
  "use memo";
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>(
    {}
  );
  const [showAllFiles, setShowAllFiles] = useState(false);
  const aggregateStats = useMemo(
    () => summarizeRowDiff(row.files),
    [row.files]
  );
  const visibleFiles = row.files.slice(0, 3);
  const hiddenFiles = row.files.slice(3);
  const hiddenFileCount = hiddenFiles.length;

  return (
    <section className="workspace-agents-status-panel__detail-turn-summary">
      <div className="agent-turn-summary-card w-full overflow-hidden rounded-[8px] text-[var(--text-primary)]">
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0 text-[15px] font-semibold leading-5 tracking-[0] text-[var(--text-primary)]">
                {translate("agentHost.agentGui.turnSummaryFilesChanged", {
                  count: row.fileCount
                })}
              </div>
              <div className="inline-flex shrink-0 items-center gap-2.5 text-[11px] font-semibold">
                {aggregateStats.added > 0 ? (
                  <span className="workspace-agents-status-panel__detail-tool-diff-added">
                    +{aggregateStats.added}
                  </span>
                ) : null}
                {aggregateStats.removed > 0 ? (
                  <span className="workspace-agents-status-panel__detail-tool-diff-removed">
                    -{aggregateStats.removed}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="agent-turn-summary-card__list">
          {visibleFiles.map((file) => {
            const key = `${file.path}:${file.messageId}`;
            return (
              <TurnSummaryFileCard
                key={key}
                file={file}
                workspaceRoot={workspaceRoot}
                expanded={Boolean(expandedFiles[key])}
                onLinkAction={onLinkAction}
                onToggle={() =>
                  setExpandedFiles((current) => ({
                    ...current,
                    [key]: !current[key]
                  }))
                }
              />
            );
          })}

          {hiddenFileCount > 0 ? (
            <CollapsibleReveal expanded={showAllFiles} preMountOnIdle>
              <div className="agent-turn-summary-card__overflow-list">
                {hiddenFiles.map((file) => {
                  const key = `${file.path}:${file.messageId}`;
                  return (
                    <TurnSummaryFileCard
                      key={key}
                      file={file}
                      workspaceRoot={workspaceRoot}
                      expanded={Boolean(expandedFiles[key])}
                      onLinkAction={onLinkAction}
                      onToggle={() =>
                        setExpandedFiles((current) => ({
                          ...current,
                          [key]: !current[key]
                        }))
                      }
                    />
                  );
                })}
              </div>
            </CollapsibleReveal>
          ) : null}

          {hiddenFileCount > 0 && !showAllFiles ? (
            <button
              type="button"
              className="agent-turn-summary-card__toggle-more flex w-full items-center gap-2 px-4 py-2.5 text-left text-[11px] font-semibold transition-colors"
              onClick={() => setShowAllFiles(true)}
            >
              <span>
                {translate("agentHost.agentGui.turnSummaryShowMoreFiles", {
                  count: hiddenFileCount
                })}
              </span>
              <ChevronDown size={16} strokeWidth={2.2} aria-hidden="true" />
            </button>
          ) : hiddenFileCount > 0 ? (
            <button
              type="button"
              className="agent-turn-summary-card__toggle-more flex w-full items-center gap-2 px-4 py-2.5 text-left text-[11px] font-semibold transition-colors"
              onClick={() => setShowAllFiles(false)}
            >
              <span>
                {translate("agentHost.agentGui.turnSummaryShowFewerFiles")}
              </span>
              <ChevronRight
                size={16}
                strokeWidth={2.2}
                aria-hidden="true"
                className="-rotate-90"
              />
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function TurnSummaryFileCard({
  file,
  workspaceRoot,
  expanded,
  onLinkAction,
  onToggle
}: {
  file: AgentTurnSummaryFileVM;
  workspaceRoot?: string | null;
  expanded: boolean;
  onLinkAction?: (action: WorkspaceLinkAction) => void;
  onToggle: () => void;
}): JSX.Element {
  "use memo";
  const action = resolveWorkspaceFileLinkAction({
    path: file.path,
    workspaceRoot: workspaceRoot,
    source: "agent-file-change"
  });
  const canOpen = Boolean(action && onLinkAction);
  const stats = summarizeFileDiff(file);
  const preview = filePreview(file);

  return (
    <div className="agent-turn-summary-card__file">
      <div className="agent-turn-summary-card__file-row flex min-w-0 items-center gap-2.5 overflow-hidden px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <button
            type="button"
            className="group/file-toggle flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-left"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            <div className="min-w-0 flex-1 overflow-hidden">
              <span
                className={`agent-turn-summary-card__path block min-w-0 truncate text-[13px] font-medium leading-5 text-[var(--text-secondary)] ${
                  file.changeType === "deleted" ? "line-through" : ""
                }`}
                title={file.path}
              >
                {file.path}
              </span>
            </div>
            <span className="shrink-0 text-[var(--text-tertiary)] opacity-0 transition-opacity group-hover/file-toggle:opacity-100 group-focus-visible/file-toggle:opacity-100">
              <ChevronRight
                size={14}
                strokeWidth={2.2}
                aria-hidden="true"
                className={`transition-transform duration-150 ease-out ${expanded ? "rotate-90" : "rotate-0"}`}
              />
            </span>
          </button>
          <span className="ml-auto inline-flex shrink-0 items-center gap-2 text-[11px] font-semibold">
            {stats.added > 0 ? (
              <span className="workspace-agents-status-panel__detail-tool-diff-added">
                +{stats.added}
              </span>
            ) : null}
            {stats.removed > 0 ? (
              <span className="workspace-agents-status-panel__detail-tool-diff-removed">
                -{stats.removed}
              </span>
            ) : null}
          </span>
        </div>

        {canOpen ? (
          <CanvasNodeGhostIconButton
            aria-label={translate(
              "agentHost.workspaceAgentSessionDetailOpenFile",
              {
                path: file.path
              }
            )}
            onClick={() => {
              onLinkAction?.(action as WorkspaceLinkAction);
            }}
          >
            <DirectLinedIcon
              width={14}
              height={14}
              aria-hidden="true"
              className="text-[var(--text-secondary)]"
            />
          </CanvasNodeGhostIconButton>
        ) : null}
      </div>

      {preview ? (
        <CollapsibleReveal expanded={expanded} preMountOnIdle>
          <div className="agent-turn-summary-card__preview rounded-none px-4 pb-3 pt-2">
            {preview}
          </div>
        </CollapsibleReveal>
      ) : null}
    </div>
  );
}

function filePreview(file: AgentTurnSummaryFileVM): JSX.Element | null {
  if (file.changeType === "created" && file.content?.trim()) {
    return (
      <AgentCodeBlock
        path={file.path}
        content={file.content}
        showHeader={false}
        collapsible
        flat
      />
    );
  }

  if (file.unifiedDiff?.trim()) {
    return (
      <AgentUnifiedPatchViewer
        path={file.path}
        diffText={file.unifiedDiff}
        showHeader={false}
        flat
      />
    );
  }

  if (file.changeType === "created" && file.newString?.trim()) {
    return (
      <AgentCodeBlock
        path={file.path}
        content={file.newString}
        showHeader={false}
        collapsible
        flat
      />
    );
  }

  if (file.oldString?.trim() || file.newString?.trim()) {
    return (
      <AgentMonacoDiffViewer
        path={file.path}
        oldValue={file.oldString ?? ""}
        newValue={file.newString ?? ""}
        flat
        showHeader={false}
      />
    );
  }

  if (file.content?.trim()) {
    return (
      <AgentCodeBlock
        path={file.path}
        content={file.content}
        showHeader={false}
        collapsible
        flat
      />
    );
  }

  return null;
}

function summarizeRowDiff(files: AgentTurnSummaryFileVM[]): {
  added: number;
  removed: number;
} {
  return files.reduce(
    (totals, file) => {
      const stats = summarizeFileDiff(file);
      return {
        added: totals.added + stats.added,
        removed: totals.removed + stats.removed
      };
    },
    { added: 0, removed: 0 }
  );
}

function summarizeFileDiff(file: AgentTurnSummaryFileVM): {
  added: number;
  removed: number;
} {
  if (file.unifiedDiff?.trim()) {
    return parseAgentUnifiedDiffStats(file.unifiedDiff);
  }
  if (file.content?.trim()) {
    return {
      added: file.content.split("\n").filter(Boolean).length || 1,
      removed: 0
    };
  }
  if (file.changeType === "created" && file.newString?.trim()) {
    return {
      added: file.newString.split("\n").filter(Boolean).length || 1,
      removed: 0
    };
  }
  if (file.changeType === "deleted" && file.oldString?.trim()) {
    return {
      added: 0,
      removed: file.oldString.split("\n").filter(Boolean).length || 1
    };
  }
  return { added: 0, removed: 0 };
}
