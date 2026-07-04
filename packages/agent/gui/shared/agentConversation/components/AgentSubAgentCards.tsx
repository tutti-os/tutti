import { memo, useState, type JSX } from "react";
import { AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { AgentLinedIcon } from "../../../app/renderer/components/icons/AgentLinedIcon";
import { translate } from "../../../i18n/index";
import type { AgentTaskSubAgentVM } from "../contracts/agentTaskItemVM";
import type { AgentToolCallVM } from "../contracts/agentToolCallVM";
import { CollapsibleReveal } from "./CollapsibleReveal";
import { formatAgentToolDurationMs } from "./tool-renderers/render-data/agentToolRenderData";

// A delegated sub-agent renders as a first-class row aligned with tool rows:
// header = "Sub-agent · <name> · <elapsed> · <status>" with a chevron, body =
// the indented detail panel (TASK / PROGRESS). Identity and status are the
// sub-agent's own (child thread nickname + lifecycle), never the spawn tool's.
export function AgentSubAgentCards({
  call,
  onLinkClick
}: {
  call: AgentToolCallVM;
  onLinkClick?: (href: string) => void;
}): JSX.Element | null {
  "use memo";
  const subAgents = call.task?.subAgents ?? [];
  if (subAgents.length === 0) {
    return null;
  }
  // No wrapper element: the transcript row's spacing-compression selectors
  // match direct .detail-tool-row children, keeping gaps identical to tools.
  return (
    <>
      {subAgents.map((subAgent) => (
        <AgentSubAgentCard
          key={subAgent.ownerThreadId}
          subAgent={subAgent}
          onLinkClick={onLinkClick}
        />
      ))}
    </>
  );
}

// Field-level memo: streaming updates elsewhere in the transcript must not
// re-render settled cards; a collapsed card renders only its header row
// (CollapsibleReveal lazy-mounts the body on first expand).
export const AgentSubAgentCard = memo(
  AgentSubAgentCardImpl,
  (prev, next) =>
    prev.onLinkClick === next.onLinkClick &&
    subAgentVMEquals(prev.subAgent, next.subAgent)
);

function subAgentVMEquals(
  left: AgentTaskSubAgentVM,
  right: AgentTaskSubAgentVM
): boolean {
  return (
    left.ownerThreadId === right.ownerThreadId &&
    left.status === right.status &&
    left.name === right.name &&
    left.task === right.task &&
    left.laneIndex === right.laneIndex &&
    left.laneCount === right.laneCount &&
    left.latestActivity === right.latestActivity &&
    left.failureDetail === right.failureDetail &&
    left.queued === right.queued &&
    left.startedAtUnixMs === right.startedAtUnixMs &&
    left.latestActivityAtUnixMs === right.latestActivityAtUnixMs &&
    left.terminalAtUnixMs === right.terminalAtUnixMs
  );
}

function AgentSubAgentCardImpl({
  subAgent,
  onLinkClick
}: {
  subAgent: AgentTaskSubAgentVM;
  onLinkClick?: (href: string) => void;
}): JSX.Element {
  "use memo";
  // Expanded by default while running; always collapsible via the header.
  const [expanded, setExpanded] = useState(subAgent.status === "running");

  return (
    <div
      className="workspace-agents-status-panel__detail-tool-row workspace-agents-status-panel__detail-tool-row--subagent"
      data-status={subAgent.status}
    >
      <button
        type="button"
        className="workspace-agents-status-panel__detail-tool-row-head workspace-agents-status-panel__detail-tool-row-head--button"
        aria-expanded={expanded}
        aria-label={subAgentAriaLabel(subAgent)}
        onClick={() => setExpanded((value) => !value)}
      >
        <SubAgentHeader subAgent={subAgent} expanded={expanded} />
      </button>
      <CollapsibleReveal expanded={expanded}>
        <div className="workspace-agents-status-panel__detail-subagent-reveal">
          <SubAgentBody subAgent={subAgent} onLinkClick={onLinkClick} />
        </div>
      </CollapsibleReveal>
    </div>
  );
}

function SubAgentHeader({
  subAgent,
  expanded
}: {
  subAgent: AgentTaskSubAgentVM;
  expanded: boolean;
}): JSX.Element {
  "use memo";
  const running = subAgent.status === "running";
  const statusLabel = subAgentStatusLabel(subAgent.status);
  const elapsedText = subAgentElapsedText(subAgent);
  const nameText = subAgentNameText(subAgent);
  return (
    <div
      data-active={running ? "true" : undefined}
      className={[
        "workspace-agents-status-panel__detail-tool-row-header-content",
        running ? "tsh-inline-scanlight-group" : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="workspace-agents-status-panel__detail-tool-row-icon tsh-inline-scanlight-icon">
        {subAgent.status === "failed" ? (
          <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
        ) : (
          <AgentLinedIcon width={16} height={16} aria-hidden="true" />
        )}
      </div>
      <div className="workspace-agents-status-panel__detail-tool-row-text">
        <strong className="workspace-agents-status-panel__detail-tool-row-title">
          {translate("agentHost.agentTool.details.subAgentFallbackName")}
        </strong>
        {nameText ? (
          <span className="workspace-agents-status-panel__detail-subagent-name">
            {nameText}
          </span>
        ) : null}
        <span className="workspace-agents-status-panel__detail-tool-status">
          {elapsedText ? `${elapsedText} · ` : ""}
          {statusLabel}
        </span>
      </div>
      {expanded ? (
        <ChevronDown
          size={12}
          strokeWidth={2.2}
          aria-hidden="true"
          className="workspace-agents-status-panel__detail-tool-row-chevron"
        />
      ) : (
        <ChevronRight
          size={12}
          strokeWidth={2.2}
          aria-hidden="true"
          className="workspace-agents-status-panel__detail-tool-row-chevron"
        />
      )}
    </div>
  );
}

function SubAgentBody({
  subAgent
}: {
  subAgent: AgentTaskSubAgentVM;
  onLinkClick?: (href: string) => void;
}): JSX.Element {
  "use memo";
  // Bash-block layout: the task is the header strip, live progress renders
  // below it - no section labels.
  return (
    <div className="workspace-agents-status-panel__detail-tool-body workspace-agents-status-panel__detail-tool-body--plain">
      <div className="workspace-agents-status-panel__detail-subagent-terminal">
        {subAgent.task ? (
          <div className="workspace-agents-status-panel__detail-subagent-task-strip">
            {subAgent.task}
          </div>
        ) : null}
        <SubAgentProgress subAgent={subAgent} />
      </div>
    </div>
  );
}

function SubAgentProgress({
  subAgent
}: {
  subAgent: AgentTaskSubAgentVM;
}): JSX.Element {
  "use memo";
  // Progress stays a single line - the sub-agent's most recent activity (or
  // failure detail), not a scrolling log.
  const text =
    subAgent.failureDetail ??
    subAgent.latestActivity ??
    translate(
      subAgent.queued
        ? "agentHost.agentTool.details.subAgentQueued"
        : "agentHost.agentTool.details.subAgentStarting"
    );
  return (
    <div
      className={`workspace-agents-status-panel__detail-subagent-activity workspace-agents-status-panel__detail-subagent-activity--in-terminal${
        subAgent.failureDetail
          ? " workspace-agents-status-panel__detail-subagent-activity--failure"
          : ""
      }`}
    >
      {text}
    </div>
  );
}

function subAgentNameText(subAgent: AgentTaskSubAgentVM): string | null {
  if (subAgent.name) {
    return subAgent.name;
  }
  return subAgent.laneCount > 1 ? `#${subAgent.laneIndex}` : null;
}

function subAgentAriaLabel(subAgent: AgentTaskSubAgentVM): string {
  return [
    translate("agentHost.agentTool.details.subAgentFallbackName"),
    subAgentNameText(subAgent),
    subAgentStatusLabel(subAgent.status)
  ]
    .filter(Boolean)
    .join(" ");
}

function subAgentStatusLabel(status: AgentTaskSubAgentVM["status"]): string {
  switch (status) {
    case "completed":
      return translate("agentHost.agentTool.statusCompleted");
    case "failed":
      return translate("agentHost.agentTool.statusFailed");
    case "canceled":
      return translate("agentHost.agentTool.statusCanceled");
    case "running":
    default:
      return translate("agentHost.agentTool.statusWorking");
  }
}

function subAgentElapsedText(subAgent: AgentTaskSubAgentVM): string | null {
  const started = subAgent.startedAtUnixMs;
  const latest = subAgent.latestActivityAtUnixMs;
  if (
    typeof started !== "number" ||
    typeof latest !== "number" ||
    latest <= started
  ) {
    return null;
  }
  return formatAgentToolDurationMs(latest - started);
}
