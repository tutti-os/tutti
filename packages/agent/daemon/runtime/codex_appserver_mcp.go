package agentruntime

import (
	"fmt"
	"strings"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// defaultCodexAppServerMCPFailureGraceWindow gives the app-server a short
// chance to finish an in-flight lifecycle response after rmcp or app-server
// reports a fatal MCP startup failure. A broken MCP worker must not turn into
// the generic 30-second thread/start or thread/resume timeout, while a response
// already in flight still wins the race.
const defaultCodexAppServerMCPFailureGraceWindow = time.Second

type codexMCPServerStartupError struct {
	Name          string
	Status        string
	FailureReason string
	Detail        string
}

func (e *codexMCPServerStartupError) Error() string {
	if e == nil {
		return "codex MCP server startup failed"
	}
	server := strings.TrimSpace(e.Name)
	if server == "" {
		server = "unknown"
	}
	reason := strings.TrimSpace(e.FailureReason)
	if reason == "" {
		reason = "failed"
	}
	detail := strings.TrimSpace(e.Detail)
	if detail == "" {
		return fmt.Sprintf("codex MCP server %s startup failed (%s)", server, reason)
	}
	return fmt.Sprintf("codex MCP server %s startup failed (%s): %s", server, reason, detail)
}

func (*codexMCPServerStartupError) Unwrap() error { return nil }

func codexMCPServerStartupFailureFromStderr(detail string) error {
	detail = strings.TrimSpace(detail)
	if detail == "" || !detailIsMcpToolServerAuth(detail) {
		return nil
	}
	return &codexMCPServerStartupError{
		Status:        "failed",
		FailureReason: "reauthenticationRequired",
		Detail:        truncateACPLogValue(detail, 1200),
	}
}

func codexMCPServerStartupFailureFromStatus(status map[string]any) error {
	if !strings.EqualFold(asString(status["status"]), "failed") {
		return nil
	}
	return &codexMCPServerStartupError{
		Name:          asString(status["name"]),
		Status:        asString(status["status"]),
		FailureReason: asString(status["failureReason"]),
		Detail:        truncateACPLogValue(strings.TrimSpace(asString(status["error"])), 1200),
	}
}

func appServerMCPServerStartupStatusPayload(params map[string]any) map[string]any {
	status := make(map[string]any)
	for _, key := range []string{"name", "status", "failureReason", "error", "threadId"} {
		if value, ok := params[key]; ok && value != nil {
			if object, ok := value.(map[string]any); ok {
				status[key] = clonePayload(object)
			} else {
				status[key] = value
			}
		}
	}
	return status
}

func codexMCPServerStartupWarningEvent(
	client *codexAppServerClient,
	session Session,
	turnID string,
	status map[string]any,
) activityshared.Event {
	name := strings.TrimSpace(asString(status["name"]))
	if name == "" {
		name = "unknown"
	}
	detail := firstNonEmptyString(
		asString(status["error"]),
		asString(status["detail"]),
	)
	if detail == "" && client != nil && client.raw != nil {
		rawDetail := client.raw.Diagnostics().StderrTail
		if detailIsMcpToolServerAuth(rawDetail) {
			detail = rawDetail
		}
	}
	if detail == "" {
		detail = firstNonEmptyString(
			asString(status["failureReason"]),
			asString(status["status"]),
		)
	}
	detail = limitVisibleErrorDetail(cleanVisibleErrorText(detail))

	title := fmt.Sprintf("MCP server %s startup failed", name)
	metadata := map[string]any{
		"messageId": "mcp-startup-warning:" + strings.TrimSpace(session.AgentSessionID) + ":" + name,
		"code":      "mcp_server_startup_failed",
		"retryable": false,
	}
	return appServerSystemNoticeEvent(session, turnID, "warning", title, detail, metadata)
}
