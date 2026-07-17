package agent

import (
	"context"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func (s *Service) SubmitPlanDecision(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turnID string,
	requestID string,
	input SubmitPlanDecisionInput,
) (agentactivitybiz.RuntimeOperation, error) {
	return s.applicationHost(serviceHostPreparation{service: s}).SubmitPlanDecision(
		ctx,
		agenthost.SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID},
		turnID,
		requestID,
		input,
	)
}

func validatePlanDecisionStrategy(provider string, input SubmitPlanDecisionInput) error {
	return agenthost.ValidatePlanDecisionStrategy(provider, input)
}
