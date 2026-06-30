package agentstatus

import (
	"context"
	"strings"
	"time"

	agentnoderesult "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent/node_result"
)

type providerSetupNodeResultInput struct {
	Error     error
	Node      string
	Provider  string
	Result    RunActionResult
	StartedAt time.Time
	Status    string
}

func (s Service) reportProviderSetupNodeResult(ctx context.Context, input providerSetupNodeResultInput) {
	if s.AnalyticsReporter == nil {
		return
	}
	status := strings.TrimSpace(input.Status)
	if status == "" {
		if input.Error != nil || input.Result.Status == RunActionFailed {
			status = "failure"
		} else {
			status = "success"
		}
	}
	errorMessage := ""
	if input.Error != nil {
		errorMessage = strings.TrimSpace(input.Error.Error())
	} else if status == "failure" {
		errorMessage = strings.TrimSpace(firstNonBlank(input.Result.Message, input.Result.ReasonCode, "Agent provider setup failed"))
	}
	var durationMS *int64
	if !input.StartedAt.IsZero() {
		elapsed := s.now().Sub(input.StartedAt).Milliseconds()
		durationMS = &elapsed
	}
	agentnoderesult.Track(ctx, s.AnalyticsReporter, agentnoderesult.BuildParams(agentnoderesult.NodeResultInput{
		DurationMS:   durationMS,
		ErrorCode:    providerSetupErrorCode(input.Result.ReasonCode, input.Error),
		ErrorMessage: errorMessage,
		Flow:         "provider_setup",
		Node:         input.Node,
		Provider:     input.Provider,
		Status:       status,
	}))
}

func providerSetupErrorCode(reasonCode string, err error) string {
	if err != nil {
		return agentnoderesult.ErrorCodeInstallFailed
	}
	switch strings.TrimSpace(reasonCode) {
	case "":
		return agentnoderesult.ErrorCodeNone
	case "install_timed_out":
		return agentnoderesult.ErrorCodeInstallTimeout
	case "install_canceled":
		return agentnoderesult.ErrorCodeInstallCanceled
	case "post_install_probe_failed":
		return agentnoderesult.ErrorCodeInstallProbeFailed
	default:
		return agentnoderesult.ErrorCodeInstallFailed
	}
}
