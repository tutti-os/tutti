package workspace

import (
	"context"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	automationruleservice "github.com/tutti-os/tutti/services/tuttid/service/automationrule"
)

func TestAutomationIssueRescueCreatesANewRunForTheFailedTask(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openIssueServiceStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "workspace-rescue", Name: "Rescue"}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}
	for _, target := range agenttargetbiz.DefaultSystemTargets(time.Now().UnixMilli()) {
		if _, err := store.PutAgentTarget(ctx, target); err != nil {
			t.Fatalf("PutAgentTarget(%q) error = %v", target.ID, err)
		}
	}
	review := automationrulebiz.Rule{
		ID:      "review",
		Enabled: true,
		Trigger: automationrulebiz.TriggerOnTaskComplete,
		Action:  automationrulebiz.ActionConsult,
		Target:  automationrulebiz.Target{Kind: automationrulebiz.TargetModel},
		Prompt:  "End with VERDICT: PASS or VERDICT: FAIL",
	}
	rescue := automationrulebiz.Rule{
		ID:      "rescue",
		Enabled: true,
		Trigger: automationrulebiz.TriggerOnTaskFailed,
		Action:  automationrulebiz.ActionDelegate,
		Target:  automationrulebiz.Target{Kind: automationrulebiz.TargetAgent},
	}
	service := IssueManagerService{
		Store:             store,
		AgentTargetReader: store,
		AutomationRules: issueAutomationRuleReaderStub{rules: []automationrulebiz.Rule{
			review,
			rescue,
		}},
	}
	detail, err := service.CreateIssueFromPlan(ctx, "workspace-rescue", CreateIssueManagerIssueFromPlanInput{
		Issue: CreateIssueManagerIssueInput{
			IssueID:             "issue-rescue",
			TopicID:             workspaceissues.DefaultTopicID,
			Title:               "Recover failed task",
			PlanningSource:      string(workspaceissues.PlanningSourceUltraPlan),
			ExecutionProfile:    workspaceissues.ExecutionProfile{ReasoningIntensity: 80, OrchestrationIntensity: 80},
			HasExecutionProfile: true,
		},
		Tasks: []CreateIssueManagerTaskItemInput{{
			TaskID:        "task-rescue",
			Title:         "Implement",
			AgentTargetID: agenttargetbiz.IDLocalCodex,
		}},
	})
	if err != nil {
		t.Fatalf("CreateIssueFromPlan() error = %v", err)
	}
	sourceRun, err := service.CreateRun(ctx, "workspace-rescue", detail.Issue.IssueID, detail.Tasks[0].TaskID, CreateIssueManagerRunInput{
		RunID:          "source-run",
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		AgentSessionID: "source-session",
	})
	if err != nil {
		t.Fatalf("CreateRun(source) error = %v", err)
	}
	if _, err := service.CompleteRun(ctx, "workspace-rescue", detail.Issue.IssueID, detail.Tasks[0].TaskID, sourceRun.RunID, CompleteIssueManagerRunInput{
		Status:       string(workspaceissues.StatusFailed),
		ErrorMessage: "provider failed",
	}); err != nil {
		t.Fatalf("CompleteRun(source) error = %v", err)
	}

	prepared, err := service.BeginAutomationIssueRescue(ctx, automationruleservice.IssueRescueInput{
		WorkspaceID:         "workspace-rescue",
		RuleID:              "rescue",
		SourceSessionID:     "source-session",
		TargetSessionID:     "rescue-session",
		TargetAgentTargetID: agenttargetbiz.IDLocalCodex,
		ExecutionDirectory:  "/worktrees/rescue",
	})
	if err != nil {
		t.Fatalf("BeginAutomationIssueRescue() error = %v", err)
	}
	if !prepared.Associated || prepared.AutomationRuleOverride == nil || prepared.AutomationRuleOverride.Disabled {
		t.Fatalf("rescue preparation = %#v", prepared)
	}
	if prepared.ReasoningIntensity == nil || *prepared.ReasoningIntensity != 80 {
		t.Fatalf("rescue reasoning intensity = %#v, want 80", prepared.ReasoningIntensity)
	}
	if got := prepared.AutomationRuleOverride.RuleIDs; len(got) != 2 || got[0] != "rescue" || got[1] != "review" {
		t.Fatalf("rescue rule ids = %v, want rescue+review", got)
	}
	rescued, err := service.GetIssueDetail(ctx, "workspace-rescue", detail.Issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail(rescue) error = %v", err)
	}
	if rescued.LatestRun == nil || rescued.LatestRun.AgentSessionID != "rescue-session" || rescued.LatestRun.Status != workspaceissues.StatusRunning {
		t.Fatalf("latest rescue run = %#v", rescued.LatestRun)
	}

	if err := service.FailAutomationIssueRescue(ctx, automationruleservice.IssueRescueFailureInput{
		WorkspaceID:     "workspace-rescue",
		TargetSessionID: "rescue-session",
		ErrorMessage:    "launch failed",
	}); err != nil {
		t.Fatalf("FailAutomationIssueRescue() error = %v", err)
	}
	failed, err := service.GetIssueDetail(ctx, "workspace-rescue", detail.Issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail(failed rescue) error = %v", err)
	}
	if failed.LatestRun == nil || failed.LatestRun.Status != workspaceissues.StatusFailed || failed.LatestRun.ErrorMessage != "launch failed" {
		t.Fatalf("failed rescue run = %#v", failed.LatestRun)
	}
}
