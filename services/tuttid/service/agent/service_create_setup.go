package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"

	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
)

func (s *Service) applyInitialAutomationRuleOverride(ctx context.Context, workspaceID string, agentSessionID string, input *automationrulebiz.SessionOverride) error {
	if input == nil {
		return nil
	}
	if s.AutomationRuleOverrides == nil {
		return errors.New("automation rule session override service is unavailable")
	}
	override := *input
	override.WorkspaceID = strings.TrimSpace(workspaceID)
	override.AgentSessionID = strings.TrimSpace(agentSessionID)
	override.RuleIDs = append([]string(nil), input.RuleIDs...)
	if _, err := s.AutomationRuleOverrides.SetSessionOverride(ctx, override); err != nil {
		return fmt.Errorf("set initial automation rule override: %w", err)
	}
	return nil
}
