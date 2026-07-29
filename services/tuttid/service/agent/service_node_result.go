package agent

import (
	"context"
	"strings"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentanalytics"
	agentnoderesult "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent/node_result"
)

type agentServiceNodeResultInput struct {
	AgentSessionID string
	Error          error
	ErrorCode      string
	Flow           string
	Node           string
	Provider       string
	StartedAt      time.Time
	Status         string
}

func (s *Service) reportAgentServiceNodeResult(ctx context.Context, input agentServiceNodeResultInput) {
	if s == nil || s.AnalyticsReporter == nil {
		return
	}
	status := strings.TrimSpace(input.Status)
	if status == "" {
		status = "success"
	}
	errorCode := strings.TrimSpace(input.ErrorCode)
	errorMessage := ""
	if input.Error != nil {
		errorMessage = strings.TrimSpace(input.Error.Error())
		if errorCode == "" {
			errorCode = classifyAgentServiceNodeErrorCode(input.Node, input.Error)
		}
	}
	var durationMS *int64
	if !input.StartedAt.IsZero() {
		elapsed := time.Since(input.StartedAt).Milliseconds()
		durationMS = &elapsed
	}
	agentnoderesult.Track(ctx, s.AnalyticsReporter, agentnoderesult.BuildParams(agentnoderesult.NodeResultInput{
		AgentSessionID: input.AgentSessionID,
		DurationMS:     durationMS,
		ErrorCode:      errorCode,
		ErrorMessage:   errorMessage,
		Flow:           input.Flow,
		Node:           input.Node,
		Provider:       input.Provider,
		Status:         status,
	}))
}

func (s *Service) reportAgentServiceNodeSuccess(ctx context.Context, agentSessionID string, flow string, node string, provider string, startedAt time.Time) {
	s.reportAgentServiceNodeResult(ctx, agentServiceNodeResultInput{
		AgentSessionID: agentSessionID,
		Flow:           flow,
		Node:           node,
		Provider:       provider,
		StartedAt:      startedAt,
		Status:         "success",
	})
}

func (s *Service) reportAgentServiceNodeFailure(ctx context.Context, agentSessionID string, flow string, node string, provider string, startedAt time.Time, err error) {
	s.reportAgentServiceNodeResult(ctx, agentServiceNodeResultInput{
		AgentSessionID: agentSessionID,
		Error:          err,
		Flow:           flow,
		Node:           node,
		Provider:       provider,
		StartedAt:      startedAt,
		Status:         "failure",
	})
}

func classifyAgentServiceNodeErrorCode(node string, err error) string {
	if err == nil {
		return agentanalytics.ErrorCodeNone
	}
	switch strings.TrimSpace(node) {
	case "content_normalized":
		return agentanalytics.ErrorCodePromptNormalizeFailed
	case "provider_runtime_checked":
		return agentanalytics.ErrorCodeProviderStatusFailed
	case "model_validated", "cwd_resolved":
		return agentanalytics.ErrorCodeSessionCreateFailed
	case "runtime_session_ready":
		return agentanalytics.ErrorCodeSessionResumeFailed
	case "runtime_prepared":
		return agentanalytics.ErrorCodeRuntimePrepareFailed
	case "runtime_started":
		return agentanalytics.ErrorCodeRuntimeStartFailed
	case "prompt_validated":
		return agentanalytics.ErrorCodePromptValidateFailed
	case "prompt_prepared":
		return agentanalytics.ErrorCodePromptPrepareFailed
	case "runtime_exec":
		return classifyRuntimeNodeErrorCode(err.Error())
	case "session_refreshed":
		return agentanalytics.ErrorCodeActivityReconcileFailed
	default:
		return agentanalytics.ErrorCodeUnknown
	}
}
