import { useEffect, useId, useState, type JSX } from "react";
import { useTranslation } from "../i18n/index";

type MermaidRenderState =
  | { status: "rendering" }
  | { status: "ready"; svg: string }
  | { status: "error" };

let mermaidRenderQueue: Promise<void> = Promise.resolve();

export function MermaidDiagram({ source }: { source: string }): JSX.Element {
  "use memo";
  const { t } = useTranslation();
  const reactId = useId();
  const diagramId = `agent-mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const [state, setState] = useState<MermaidRenderState>({
    status: "rendering"
  });

  useEffect(() => {
    let canceled = false;
    setState({ status: "rendering" });

    void renderMermaidDiagram(diagramId, source).then(
      (svg) => {
        if (!canceled) {
          setState({ status: "ready", svg });
        }
      },
      () => {
        if (!canceled) {
          setState({ status: "error" });
        }
      }
    );

    return () => {
      canceled = true;
    };
  }, [diagramId, source]);

  if (state.status === "error") {
    return (
      <div
        className="my-2 box-border w-full min-w-0 rounded-[8px] border border-[var(--line-2)] bg-[var(--background-panel)] p-3"
        data-agent-mermaid-diagram="true"
        data-agent-mermaid-status="error"
      >
        <p className="mb-2 text-[12px] text-[var(--text-tertiary)]">
          {t("agentHost.workspaceAgentMermaidRenderFailed")}
        </p>
        <pre className="m-0 overflow-auto rounded-[6px] bg-[var(--transparency-block)] px-2.5 py-2">
          <code className="language-mermaid">{source}</code>
        </pre>
      </div>
    );
  }

  if (state.status === "rendering") {
    return (
      <div
        className="my-2 box-border flex min-h-24 w-full min-w-0 items-center justify-center rounded-[8px] border border-[var(--line-2)] bg-[var(--background-panel)] p-3 text-[12px] text-[var(--text-tertiary)]"
        data-agent-mermaid-diagram="true"
        data-agent-mermaid-status="rendering"
        role="status"
      >
        {t("agentHost.workspaceAgentMermaidRendering")}
      </div>
    );
  }

  return (
    <div
      className="my-2 box-border w-full min-w-0 overflow-x-auto rounded-[8px] border border-[var(--line-2)] bg-[var(--background-panel)] p-3 [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
      data-agent-mermaid-diagram="true"
      data-agent-mermaid-status="ready"
      role="img"
      aria-label={t("agentHost.workspaceAgentMermaidDiagramLabel")}
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}

function renderMermaidDiagram(id: string, source: string): Promise<string> {
  const render = mermaidRenderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "neutral",
      htmlLabels: false,
      maxEdges: 500,
      maxTextSize: 50_000,
      flowchart: {
        htmlLabels: false,
        useMaxWidth: true
      }
    });
    const result = await mermaid.render(id, source);
    return result.svg;
  });

  mermaidRenderQueue = render.then(
    () => undefined,
    () => undefined
  );
  return render;
}
