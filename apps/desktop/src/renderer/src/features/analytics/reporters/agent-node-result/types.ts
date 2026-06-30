import type { AnalyticsReporterParams } from "../baseReporter.ts";
import type { AgentAnalyticsErrorCode } from "../agent-error-fields.ts";

export type AgentAnalyticsFlow =
  | "provider_setup"
  | "session_create"
  | "message_send"
  | "runtime_activity";

export type AgentAnalyticsNode =
  | "activate_session"
  | "activity_event_stream"
  | "activity_projection_messages"
  | "activity_projection_state"
  | "activity_reconcile_messages"
  | "activity_reconcile_state"
  | "agent_gui_refresh"
  | "content_normalized"
  | "create_session_request"
  | "cwd_resolved"
  | "install_action_requested"
  | "install_adapter"
  | "install_cli"
  | "install_daemon_action"
  | "install_post_probe"
  | "login_action_requested"
  | "login_auth_poll"
  | "login_ready_detected"
  | "login_terminal_launch"
  | "message_sent_reported"
  | "model_validated"
  | "prompt_prepared"
  | "prompt_validated"
  | "provider_runtime_checked"
  | "provider_status_detect"
  | "provider_status_request"
  | "runtime_event_received"
  | "runtime_exec"
  | "runtime_prepared"
  | "runtime_session_ready"
  | "runtime_started"
  | "send_input_request"
  | "session_refreshed"
  | "session_started_reported";

export type AgentAnalyticsNodeStatus = "success" | "failure";

export interface AgentNodeResultParams extends AnalyticsReporterParams {
  agentSessionId: string | null;
  durationMs: number | null;
  errorCode: AgentAnalyticsErrorCode;
  errorMessage: string;
  flow: AgentAnalyticsFlow;
  node: AgentAnalyticsNode;
  status: AgentAnalyticsNodeStatus;
  /** Legacy aliases kept while downstream dashboards migrate to flow/node/status. */
  nodeName: string;
  provider: string | null;
  success: boolean;
}
