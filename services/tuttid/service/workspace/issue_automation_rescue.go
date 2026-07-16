package workspace

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/google/uuid"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	automationruleservice "github.com/tutti-os/tutti/services/tuttid/service/automationrule"
)

// BeginAutomationIssueRescue associates a failure-triggered automation target
// with the same Issue Task before the target Session can start. Non-Issue
// source Sessions remain ordinary workspace automation and return
// Associated=false.
func (s IssueManagerService) BeginAutomationIssueRescue(
	ctx context.Context,
	input automationruleservice.IssueRescueInput,
) (automationruleservice.IssueRescuePreparation, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sourceSessionID := strings.TrimSpace(input.SourceSessionID)
	targetSessionID := strings.TrimSpace(input.TargetSessionID)
	if s.Store == nil || workspaceID == "" || sourceSessionID == "" || targetSessionID == "" {
		return automationruleservice.IssueRescuePreparation{}, nil
	}
	runs, err := s.Store.ListRuns(ctx, workspaceID, "", "")
	if err != nil {
		return automationruleservice.IssueRescuePreparation{}, err
	}
	sort.SliceStable(runs, func(left, right int) bool {
		return runs[left].UpdatedAtUnixMS > runs[right].UpdatedAtUnixMS
	})
	var sourceRun *workspaceissues.Run
	for index := range runs {
		candidate := &runs[index]
		if strings.TrimSpace(candidate.AgentSessionID) != sourceSessionID {
			continue
		}
		if candidate.Status != workspaceissues.StatusFailed && candidate.Status != workspaceissues.StatusCanceled {
			continue
		}
		sourceRun = candidate
		break
	}
	if sourceRun == nil {
		return automationruleservice.IssueRescuePreparation{}, nil
	}
	issue, err := s.Store.GetIssue(ctx, workspaceID, sourceRun.IssueID)
	if err != nil {
		return automationruleservice.IssueRescuePreparation{}, err
	}
	if issue.ExecutionProfile.OrchestrationIntensity < issueOrchestrationRescueThreshold {
		return automationruleservice.IssueRescuePreparation{}, fmt.Errorf("issue orchestration intensity does not allow automatic failure rescue")
	}

	agentTargetID := strings.TrimSpace(input.TargetAgentTargetID)
	provider := ""
	modelPlanID := strings.TrimSpace(input.ModelPlanID)
	model := strings.TrimSpace(input.Model)
	if strings.HasPrefix(agentTargetID, workspaceagentbiz.IDPrefix) && s.WorkspaceAgents != nil {
		resolved, resolveErr := s.WorkspaceAgents.Resolve(ctx, workspaceID, agentTargetID)
		if resolveErr != nil {
			return automationruleservice.IssueRescuePreparation{}, resolveErr
		}
		provider = strings.TrimSpace(resolved.HarnessTarget.Provider)
		if modelPlanID == "" && resolved.ModelPlan != nil {
			modelPlanID = strings.TrimSpace(resolved.ModelPlan.ID)
		}
		if model == "" {
			model = strings.TrimSpace(resolved.EffectiveModel)
		}
	}
	if err := s.validateIssueTaskAssignment(ctx, workspaceID, agentTargetID, modelPlanID, model); err != nil {
		return automationruleservice.IssueRescuePreparation{}, err
	}
	if _, err := s.CreateRun(ctx, workspaceID, sourceRun.IssueID, sourceRun.TaskID, CreateIssueManagerRunInput{
		RunID:              uuid.NewString(),
		AgentTargetID:      agentTargetID,
		AgentProvider:      provider,
		AgentSessionID:     targetSessionID,
		ExecutionDirectory: strings.TrimSpace(input.ExecutionDirectory),
		ModelPlanID:        modelPlanID,
		Model:              model,
	}); err != nil {
		return automationruleservice.IssueRescuePreparation{}, err
	}
	reasoningIntensity := issue.ExecutionProfile.ReasoningIntensity
	return automationruleservice.IssueRescuePreparation{
		Associated: true,
		AutomationRuleOverride: s.issueAutomationRuleOverride(
			ctx,
			workspaceID,
			targetSessionID,
			issue.ExecutionProfile.OrchestrationIntensity,
		),
		ReasoningIntensity: &reasoningIntensity,
	}, nil
}

func (s IssueManagerService) FailAutomationIssueRescue(
	ctx context.Context,
	input automationruleservice.IssueRescueFailureInput,
) error {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	targetSessionID := strings.TrimSpace(input.TargetSessionID)
	if s.Store == nil || workspaceID == "" || targetSessionID == "" {
		return nil
	}
	runs, err := s.domainService().ListRunningRuns(ctx, workspaceID, defaultIssueRunReconcileLimit)
	if err != nil {
		return err
	}
	for _, run := range runs {
		if strings.TrimSpace(run.AgentSessionID) != targetSessionID {
			continue
		}
		_, err = s.CompleteRun(ctx, workspaceID, run.IssueID, run.TaskID, run.RunID, CompleteIssueManagerRunInput{
			Status:       string(workspaceissues.StatusFailed),
			ErrorMessage: strings.TrimSpace(input.ErrorMessage),
		})
		return err
	}
	return nil
}
