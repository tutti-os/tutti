import { useCallback, useMemo, useRef, useState, type JSX } from "react";
import { Check, Copy } from "lucide-react";
import { translate } from "../../../../../i18n/index";
import { AgentToolScrollArea } from "../AgentToolScrollArea";

const MAX_OUTPUT_LINES = 200;

export function AgentTerminalBlock({
  command,
  stdout,
  stderr,
  status
}: {
  command: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number | null;
  status: "running" | "completed" | "failed" | "unknown";
}): JSX.Element | null {
  "use memo";
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outputText = useMemo(
    () => [stdout, stderr].filter(Boolean).join("\n"),
    [stdout, stderr]
  );
  const outputLines = useMemo(
    () => (outputText ? outputText.split("\n") : []),
    [outputText]
  );
  const truncated = !expanded && outputLines.length > MAX_OUTPUT_LINES;
  const visibleOutput = truncated
    ? outputLines.slice(0, MAX_OUTPUT_LINES).join("\n")
    : outputText;
  const failed = status === "failed";
  const hasOutput = Boolean(visibleOutput);

  const handleCopy = useCallback(() => {
    void navigator.clipboard?.writeText(outputText).then(() => {
      setCopied(true);
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [outputText]);

  const copyButton = hasOutput ? (
    <button
      type="button"
      data-testid="agent-terminal-copy"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-[4px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-secondary)]"
      aria-label={translate("agentHost.agentGui.copyCode")}
      title={translate("agentHost.agentGui.copyCode")}
      onClick={handleCopy}
    >
      {copied ? (
        <Check size={13} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Copy size={13} strokeWidth={2} aria-hidden="true" />
      )}
    </button>
  ) : null;
  const disclosureButton =
    outputLines.length > MAX_OUTPUT_LINES ? (
      <button
        type="button"
        className="mt-2 flex w-fit items-center border-0 bg-transparent p-0 text-left text-[11px] font-medium text-[var(--tutti-purple)] transition-colors hover:underline focus-visible:underline focus-visible:outline-none"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded
          ? translate("agentHost.agentTool.details.collapseOutput")
          : translate("agentHost.agentTool.details.showFullOutput", {
              count: outputLines.length
            })}
      </button>
    ) : null;

  return (
    <div className="workspace-agents-status-panel__detail-tool-terminal overflow-hidden rounded-[8px] border border-[var(--line-2)] bg-[var(--background-panel)]">
      {command ? (
        <div
          className={`flex min-w-0 items-center gap-3 px-3 text-[11px] text-[var(--text-secondary)] ${
            hasOutput
              ? "border-b border-[var(--line-2)] bg-[var(--transparency-block)] py-1.5"
              : "bg-[var(--transparency-block)] py-2"
          }`}
          data-agent-terminal-command-row="true"
        >
          <span className="shrink-0 font-semibold text-[var(--tutti-purple)]">
            $
          </span>
          <span
            className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]"
            data-agent-terminal-command="true"
          >
            {command}
          </span>
          {copyButton}
        </div>
      ) : null}
      {hasOutput ? (
        <AgentToolScrollArea
          maxHeightClassName="max-h-[160px]"
          viewportClassName={`px-3 py-2 text-[11px] leading-5 ${
            failed ? "text-[var(--state-danger)]" : "text-[var(--text-primary)]"
          }`}
        >
          <pre className="m-0 min-w-0 max-w-full whitespace-pre-wrap [overflow-wrap:anywhere]">
            <code>{visibleOutput}</code>
          </pre>
          {disclosureButton}
        </AgentToolScrollArea>
      ) : null}
    </div>
  );
}
