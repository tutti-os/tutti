import { normalizeTuttidError } from "@tutti-os/client-tuttid-ts";

export const AgentAnalyticsErrorCode = {
  None: "agent_error_none",
  ProviderStatusFailed: "agent_provider_status_failed",
  InstallFailed: "agent_install_failed",
  InstallTimeout: "agent_install_timeout",
  InstallCanceled: "agent_install_canceled",
  InstallProbeFailed: "agent_install_probe_failed",
  LoginLaunchFailed: "agent_login_launch_failed",
  LoginTimeout: "agent_login_timeout",
  LoginAuthFailed: "agent_login_auth_failed",
  SessionCreateFailed: "agent_session_create_failed",
  SessionResumeFailed: "agent_session_resume_failed",
  RuntimePrepareFailed: "agent_runtime_prepare_failed",
  RuntimeStartFailed: "agent_runtime_start_failed",
  RuntimeExecFailed: "agent_runtime_exec_failed",
  RuntimeNetworkDisconnected: "agent_runtime_network_disconnected",
  RuntimeProcessExited: "agent_runtime_process_exited",
  RuntimeCanceled: "agent_runtime_canceled",
  PromptNormalizeFailed: "agent_prompt_normalize_failed",
  PromptValidateFailed: "agent_prompt_validate_failed",
  PromptPrepareFailed: "agent_prompt_prepare_failed",
  ActivityEventStreamFailed: "agent_activity_event_stream_failed",
  ActivityReconcileFailed: "agent_activity_reconcile_failed",
  Unknown: "agent_unknown_error"
} as const;

export type AgentAnalyticsErrorCode =
  (typeof AgentAnalyticsErrorCode)[keyof typeof AgentAnalyticsErrorCode];

export interface AgentAnalyticsErrorFields {
  errorCode: AgentAnalyticsErrorCode;
  errorMessage: string;
}

export const agentAnalyticsSuccessFields = {
  errorCode: AgentAnalyticsErrorCode.None,
  errorMessage: ""
} satisfies AgentAnalyticsErrorFields;

export function agentAnalyticsErrorFields(
  error: unknown,
  fallbackCode: AgentAnalyticsErrorCode
): AgentAnalyticsErrorFields {
  const normalized = normalizeTuttidError(error);
  return {
    errorCode: mapTuttidErrorCode(
      normalized?.reason ?? normalized?.code,
      fallbackCode
    ),
    errorMessage: errorMessageOf(error)
  };
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  const text = String(error).trim();
  return text || "Unknown agent error";
}

function mapTuttidErrorCode(
  code: string | null | undefined,
  fallbackCode: AgentAnalyticsErrorCode
): AgentAnalyticsErrorCode {
  const normalized = code?.trim();
  if (!normalized) {
    return fallbackCode;
  }
  if (
    normalized === "auth_required" ||
    normalized === "authentication_failed"
  ) {
    return AgentAnalyticsErrorCode.LoginAuthFailed;
  }
  if (normalized === "agent_provider_unavailable") {
    return AgentAnalyticsErrorCode.ProviderStatusFailed;
  }
  if (normalized === "acp_adapter_launch_failed") {
    return AgentAnalyticsErrorCode.RuntimeStartFailed;
  }
  return fallbackCode;
}
