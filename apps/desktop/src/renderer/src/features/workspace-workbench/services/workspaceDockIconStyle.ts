import { createElement, type ReactNode } from "react";
import type { DesktopDockIconStyle } from "@shared/preferences";
import type { DesktopThemeAppearance } from "@shared/theme";
import type { AgentGuiWorkbenchProvider } from "@tutti-os/agent-gui/workbench/types";

const defaultFilesIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/files.png",
  import.meta.url
).href;
const defaultDocumentIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/apps/document.png",
  import.meta.url
).href;
const defaultTerminalIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/terminal.png",
  import.meta.url
).href;
const defaultApplicationsIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/applications.png",
  import.meta.url
).href;
const defaultBrowserIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/browser.png",
  import.meta.url
).href;
const defaultClaudeCodeIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/claudecode.png",
  import.meta.url
).href;
const defaultCodexIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/codex.png",
  import.meta.url
).href;
const defaultAgentUnifiedIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/agent-unified.png",
  import.meta.url
).href;
const defaultGeminiIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/gemini.png",
  import.meta.url
).href;
const defaultHermesIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/hermes.png",
  import.meta.url
).href;
const defaultIssueIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/issue.png",
  import.meta.url
).href;
const defaultOpenclawIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/openclaw.png",
  import.meta.url
).href;
const defaultTuttiIconUrl = new URL(
  "../../../assets/workspace-canvas/dock/default/tutti.png",
  import.meta.url
).href;

export interface WorkspaceDockIconSet {
  agentUnified: string;
  agents: Record<AgentGuiWorkbenchProvider, string>;
  applications: string;
  browser: string;
  document: string;
  files: string;
  issue: string;
  launchpadTiles: readonly string[];
  terminal: string;
}

export function resolveWorkspaceDockIconSet(_input: {
  appearance: DesktopThemeAppearance;
  style: DesktopDockIconStyle;
}): WorkspaceDockIconSet {
  const agents: Record<AgentGuiWorkbenchProvider, string> = {
    "claude-code": defaultClaudeCodeIconUrl,
    codex: defaultCodexIconUrl,
    gemini: defaultGeminiIconUrl,
    hermes: defaultHermesIconUrl,
    nexight: defaultTuttiIconUrl,
    openclaw: defaultOpenclawIconUrl
  };
  return {
    agentUnified: defaultAgentUnifiedIconUrl,
    agents,
    applications: defaultApplicationsIconUrl,
    browser: defaultBrowserIconUrl,
    document: defaultDocumentIconUrl,
    files: defaultFilesIconUrl,
    issue: defaultIssueIconUrl,
    launchpadTiles: [
      agents.nexight,
      agents.hermes,
      agents.openclaw,
      agents.gemini
    ],
    terminal: defaultTerminalIconUrl
  };
}

export function createWorkspaceDockImageIcon(src: string): ReactNode {
  return createElement("img", {
    alt: "",
    draggable: false,
    src
  });
}
