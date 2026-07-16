package workspace

import (
	"context"
	"strings"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
)

type IssueAssignmentAgentTargetReader interface {
	GetAgentTarget(context.Context, string) (agenttargetbiz.Target, error)
}

type IssueAssignmentWorkspaceAgentResolver interface {
	Resolve(context.Context, string, string) (workspaceagentbiz.Resolved, error)
}

type IssueModelPlanReader interface {
	GetModelPlan(context.Context, string, string) (modelplanbiz.Plan, error)
}

// validateIssueTaskAssignment rejects a task assignment before it becomes
// durable. Runtime launch repeats these checks because a Plan or Agent can be
// disabled after save, but the Issue editor must never knowingly persist an
// unusable combination.
func (s IssueManagerService) validateIssueTaskAssignment(
	ctx context.Context,
	workspaceID string,
	agentTargetID string,
	modelPlanID string,
	model string,
) error {
	agentTargetID = strings.TrimSpace(agentTargetID)
	modelPlanID = strings.TrimSpace(modelPlanID)
	model = strings.TrimSpace(model)
	if agentTargetID == "" {
		if modelPlanID != "" || model != "" {
			return workspaceissues.ErrInvalidArgument
		}
		return nil
	}
	var target agenttargetbiz.Target
	var assignmentPlan *modelplanbiz.Plan
	if strings.HasPrefix(agentTargetID, workspaceagentbiz.IDPrefix) {
		if s.WorkspaceAgents == nil {
			return workspaceissues.ErrInvalidArgument
		}
		resolved, err := s.WorkspaceAgents.Resolve(ctx, strings.TrimSpace(workspaceID), agentTargetID)
		if err != nil {
			return workspaceissues.ErrInvalidArgument
		}
		target = resolved.HarnessTarget
		assignmentPlan = resolved.ModelPlan
	} else {
		if s.AgentTargetReader == nil {
			return workspaceissues.ErrInvalidArgument
		}
		var err error
		target, err = s.AgentTargetReader.GetAgentTarget(ctx, agentTargetID)
		if err != nil {
			return workspaceissues.ErrInvalidArgument
		}
	}
	target, err := agenttargetbiz.NormalizeTarget(target)
	if err != nil || !target.Enabled {
		return workspaceissues.ErrInvalidArgument
	}
	if modelPlanID == "" {
		if assignmentPlan != nil && model != "" && !modelplanbiz.ModelsContain(assignmentPlan.Models, model) {
			return workspaceissues.ErrInvalidArgument
		}
		return nil
	}
	if s.ModelPlanReader == nil {
		return workspaceissues.ErrInvalidArgument
	}
	plan, err := s.ModelPlanReader.GetModelPlan(ctx, strings.TrimSpace(workspaceID), modelPlanID)
	if err != nil {
		return workspaceissues.ErrInvalidArgument
	}
	plan, err = modelplanbiz.Normalize(plan)
	if err != nil {
		return workspaceissues.ErrInvalidArgument
	}
	if plan.Status() != modelplanbiz.StatusPendingFirstUse && plan.Status() != modelplanbiz.StatusReady {
		return workspaceissues.ErrInvalidArgument
	}
	requiredProtocol, supported := agentproviderbiz.ModelPlanProtocol(target.Provider)
	if !supported || string(plan.Protocol) != requiredProtocol {
		return workspaceissues.ErrInvalidArgument
	}
	if model != "" && !modelplanbiz.ModelsContain(plan.Models, model) {
		return workspaceissues.ErrInvalidArgument
	}
	return nil
}
