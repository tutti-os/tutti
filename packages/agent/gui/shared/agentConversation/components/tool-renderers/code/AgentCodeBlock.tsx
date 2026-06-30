import { useMemo, useState, type JSX } from "react";
import { translate } from "../../../../../i18n/index";
import { AgentPathTailLabel } from "../AgentPathTailLabel";

const MAX_VISIBLE_LINES = 120;

export function AgentCodeBlock({
  path,
  content,
  language,
  showHeader = true,
  collapsible = false,
  flat = false
}: {
  path?: string | null;
  content: string;
  language?: string | null;
  showHeader?: boolean;
  collapsible?: boolean;
  flat?: boolean;
}): JSX.Element | null {
  "use memo";
  const [expanded, setExpanded] = useState(false);
  const normalized = content.trimEnd();
  const lines = useMemo(
    () => (normalized ? normalized.split("\n") : []),
    [normalized]
  );
  const lineCount = lines.length;
  const truncated = collapsible && !expanded && lineCount > MAX_VISIBLE_LINES;
  const visibleContent = truncated
    ? lines.slice(0, MAX_VISIBLE_LINES).join("\n")
    : normalized;
  const visibleLines = useMemo(
    () =>
      (truncated ? lines.slice(0, MAX_VISIBLE_LINES) : lines).map(
        (line, lineIndex) => ({
          key: `${lineIndex + 1}:${line}`,
          line,
          lineNumber: lineIndex + 1
        })
      ),
    [lines, truncated]
  );
  const addedCount = lineCount;
  const fileLabel = fileNameFromPath(path) ?? path ?? "Code";
  if (!normalized) {
    return null;
  }
  const disclosureButton =
    collapsible && lineCount > MAX_VISIBLE_LINES ? (
      <button
        type="button"
        className="flex w-full items-center px-3 py-2 text-left text-[11px] font-medium text-[var(--tutti-purple)] transition-colors"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded
          ? translate("agentHost.agentTool.details.collapseContent")
          : translate("agentHost.agentTool.details.showFullContent", {
              count: lineCount
            })}
      </button>
    ) : null;
  return (
    <div
      className={`workspace-agents-status-panel__detail-tool-code overflow-hidden rounded-[8px] border border-[var(--line-2)] bg-[var(--background-panel)] ${
        flat ? "workspace-agents-status-panel__detail-tool-code--flat" : ""
      }`}
    >
      {flat ? (
        <>
          {showHeader ? (
            <div className="flex items-center justify-between gap-3 border-b border-[var(--line-2)] bg-[var(--transparency-block)] px-3 py-1.5 text-[11px]">
              <span
                className="truncate font-[var(--tsh-font-mono)] text-[var(--text-secondary)]"
                title={path ?? undefined}
              >
                {fileLabel}
              </span>
              <span className="shrink-0 font-semibold text-[var(--state-success)]">
                +{addedCount}
              </span>
            </div>
          ) : null}
          <div className="workspace-agents-status-panel__detail-scroll-region max-h-[240px] overflow-auto bg-[var(--background-panel)]">
            {visibleLines.map((line) => (
              <div
                key={line.key}
                className="grid grid-cols-[56px_minmax(0,1fr)] border-l-[3px] border-l-[var(--state-success)] font-[var(--tsh-font-mono)] text-[11px] leading-6"
              >
                <div className="select-none px-2.5 text-right text-[color:color-mix(in_srgb,var(--state-success)_90%,transparent)]">
                  {line.lineNumber}
                </div>
                <pre className="m-0 overflow-x-auto px-3 py-0 text-[var(--text-primary)]">
                  <code>{line.line || " "}</code>
                </pre>
              </div>
            ))}
            {disclosureButton}
          </div>
        </>
      ) : (
        <>
          {showHeader ? (
            <div className="flex items-center justify-between gap-3 border-b border-[var(--line-2)] bg-[var(--transparency-block)] px-3 py-1.5 text-[11px] text-[var(--text-secondary)]">
              <AgentPathTailLabel
                path={path}
                fallback="Code"
                className="font-[var(--tsh-font-mono)]"
              />
              <span className="shrink-0">
                {language ? `${language} · ` : ""}
                {lineCount} lines
              </span>
            </div>
          ) : null}
          <pre className="workspace-agents-status-panel__detail-scroll-region max-h-[200px] overflow-auto px-3 py-2 text-[11px] leading-5 text-[var(--text-primary)]">
            <code>{visibleContent}</code>
          </pre>
          {disclosureButton}
        </>
      )}
    </div>
  );
}

function fileNameFromPath(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  const normalized = path.trim();
  if (!normalized) {
    return null;
  }
  const segments = normalized.split("/");
  return segments[segments.length - 1] || normalized;
}
