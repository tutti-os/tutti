import type { CSSProperties, ReactNode } from "react";
import { AgentGUIStartupShell } from "@tutti-os/agent-gui/startup-shell";
import { useTranslation } from "@renderer/i18n";

const standaloneAgentStartupRailWidthPx = 332;

export interface StandaloneAgentStartupShellProps {
  scope?: "body" | "window";
}

export function StandaloneAgentStartupShell({
  scope = "window"
}: StandaloneAgentStartupShellProps): ReactNode {
  const { t } = useTranslation();
  const loadingLabel = t("common.loading");
  const body = <AgentGUIStartupShell loadingLabel={loadingLabel} />;

  if (scope === "body") {
    return body;
  }

  return (
    <main
      aria-busy="true"
      className="workbench-window h-screen min-h-0 overflow-hidden bg-background"
      data-agent-gui-standalone-window="true"
      data-agent-gui-startup-shell="window"
      data-display-mode="floating"
      data-window-header-border="none"
      data-window-header-layout="overlay"
      style={{
        border: 0,
        borderRadius: 0,
        boxShadow: "none",
        height: "100vh",
        maxHeight: "100vh",
        maxWidth: "100vw",
        overflow: "hidden",
        width: "100vw"
      }}
    >
      <div className="workbench-window__header workbench-window__header--custom">
        <StandaloneAgentStartupHeader />
      </div>
      <div className="workbench-window__body flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        {body}
      </div>
      <span className="sr-only" role="status">
        {loadingLabel}
      </span>
    </main>
  );
}

function StandaloneAgentStartupHeader(): ReactNode {
  return (
    <header
      className="agent-gui-workbench-header"
      data-agent-gui-standalone-window-header="true"
      data-agent-gui-workbench-header="true"
      data-agent-gui-workbench-header-collapsed="false"
      data-agent-gui-workbench-header-has-session="false"
      style={
        {
          "--agent-gui-workbench-header-rail-width": `${standaloneAgentStartupRailWidthPx}px`
        } as CSSProperties
      }
    >
      <div className="agent-gui-workbench-header__primary">
        <div className="agent-gui-workbench-header__traffic-lights">
          {(["close", "minimize", "maximize"] as const).map((tone) => (
            <span
              aria-hidden="true"
              className="agent-gui-workbench-header__traffic-light"
              data-agent-gui-workbench-traffic-light={tone}
              key={tone}
            />
          ))}
        </div>
        <span
          aria-hidden="true"
          className="h-3 w-12 rounded-full bg-[var(--transparency-block)]"
        />
        <div className="ml-auto flex items-center gap-2" aria-hidden="true">
          <span className="size-7 rounded-md bg-[var(--transparency-block)]" />
          <span className="size-7 rounded-md bg-[var(--transparency-block)]" />
        </div>
      </div>
      <div className="agent-gui-workbench-header__detail">
        <div
          aria-hidden="true"
          className="ml-auto flex items-center gap-2 pr-4"
        >
          <span className="size-7 rounded-md bg-[var(--transparency-block)]" />
          <span className="size-7 rounded-md bg-[var(--transparency-block)]" />
        </div>
      </div>
    </header>
  );
}
