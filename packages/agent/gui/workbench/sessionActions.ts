export const AGENT_GUI_WORKBENCH_SESSION_ACTION_EVENT =
  "tutti:agent-gui-workbench-session-action";

export type AgentGuiWorkbenchSessionAction =
  | "rename"
  | "copy-markdown"
  | "copy-reference";

const agentGuiWorkbenchSessionActions: readonly AgentGuiWorkbenchSessionAction[] =
  ["rename", "copy-markdown", "copy-reference"];

export function isAgentGuiWorkbenchSessionAction(
  value: unknown
): value is AgentGuiWorkbenchSessionAction {
  return agentGuiWorkbenchSessionActions.includes(
    value as AgentGuiWorkbenchSessionAction
  );
}

export interface AgentGuiWorkbenchSessionActionDetail {
  action: AgentGuiWorkbenchSessionAction;
  /**
   * Session the header menu was rendered for. Null lets the consumer fall
   * back to its active conversation; carrying the id pins the action to the
   * conversation the user saw when they clicked.
   */
  agentSessionId: string | null;
  instanceId: string;
}

export interface AgentGuiWorkbenchSessionActionRequest {
  action: AgentGuiWorkbenchSessionAction;
  agentSessionId: string | null;
  sequence: number;
}

export function dispatchAgentGuiWorkbenchSessionAction(
  detail: AgentGuiWorkbenchSessionActionDetail
): void {
  window.dispatchEvent(
    new CustomEvent<AgentGuiWorkbenchSessionActionDetail>(
      AGENT_GUI_WORKBENCH_SESSION_ACTION_EVENT,
      { detail }
    )
  );
}

export interface AgentGuiWorkbenchSessionMenuCopy {
  moreSessionActions: string;
  renameSession: string;
  copyAsMarkdown: string;
  copyAsReference: string;
}
