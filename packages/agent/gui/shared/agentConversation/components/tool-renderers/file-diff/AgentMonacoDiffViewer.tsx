import { lazy, Suspense, type JSX } from "react";
import { AtomIcon } from "../../../../../app/renderer/components/icons/AtomIcon";
import { translate } from "../../../../../i18n/index";
import { AgentPathTailLabel } from "../AgentPathTailLabel";

const MonacoDiffEditor = lazy(async () => {
  const module = await import("@monaco-editor/react");
  return { default: module.DiffEditor };
});

export function AgentMonacoDiffViewer({
  path,
  oldValue,
  newValue,
  flat = false,
  showHeader = true
}: {
  path?: string | null;
  oldValue: string;
  newValue: string;
  flat?: boolean;
  showHeader?: boolean;
}): JSX.Element {
  "use memo";
  return (
    <div
      className={`overflow-hidden rounded-[8px] border border-[var(--line-2)] bg-[var(--background-panel)] ${
        flat ? "workspace-agents-status-panel__detail-tool-monaco--flat" : ""
      }`}
    >
      {showHeader ? (
        <div
          className="border-b border-[var(--line-2)] bg-[var(--transparency-block)] px-3 py-1.5 text-[11px] text-[var(--text-secondary)]"
          data-agent-diff-header="true"
        >
          <AgentPathTailLabel
            path={path}
            fallback="Diff"
            className="font-[var(--tsh-font-mono)]"
          />
        </div>
      ) : null}
      <div className="h-[220px] bg-[var(--background-panel)]">
        <Suspense
          fallback={
            <div className="flex items-center gap-1.5 px-3 py-2.5 text-[11px] text-[var(--text-secondary)]">
              <AtomIcon
                size={14}
                active
                aria-hidden="true"
                className="shrink-0"
              />
              <span>
                {translate("agentHost.agentTool.details.loadingDiff")}
              </span>
            </div>
          }
        >
          <MonacoDiffEditor
            original={oldValue}
            modified={newValue}
            language={languageForPath(path)}
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              automaticLayout: true
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}

function languageForPath(path: string | null | undefined): string {
  const extension = path?.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "go":
      return "go";
    case "md":
      return "markdown";
    case "json":
      return "json";
    default:
      return "plaintext";
  }
}
