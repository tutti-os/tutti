package workspace

import (
	"context"
	"errors"
	"testing"
	"time"

	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	modelpolicybiz "github.com/tutti-os/tutti/services/tuttid/biz/modelpolicy"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
)

func TestSQLiteStoreAutomationRuleRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createModelPlanTestWorkspace(t, store, "ws-automation")
	now := time.UnixMilli(1700000000000).UTC()
	rule, err := automationrulebiz.Normalize(automationrulebiz.Rule{
		ID: "automation-rule:one", WorkspaceID: "ws-automation", Name: "Consult after completion",
		Enabled: true, Action: automationrulebiz.ActionConsult,
		Target: automationrulebiz.Target{ModelPlanID: "plan-1", Model: "reasoner", RequiredCapabilities: []string{"reasoning"}},
		Budget: automationrulebiz.Budget{MaxRunsPerSession: 2, MaxTotalTokensPerSession: 5000},
		Prompt: "Review the result.", CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateAutomationRule(ctx, rule); err != nil {
		t.Fatalf("CreateAutomationRule() error = %v", err)
	}
	loaded, err := store.GetAutomationRule(ctx, rule.WorkspaceID, rule.ID)
	if err != nil {
		t.Fatalf("GetAutomationRule() error = %v", err)
	}
	if loaded.Target.Model != "reasoner" || len(loaded.Target.RequiredCapabilities) != 1 || loaded.Budget.MaxRunsPerSession != 2 {
		t.Fatalf("loaded rule = %#v", loaded)
	}
	updateInput := loaded
	updateInput.Name = "Updated consult"
	updateInput.UpdatedAt = now.Add(time.Minute)
	updated, err := store.UpdateAutomationRule(ctx, updateInput)
	if err != nil {
		t.Fatalf("UpdateAutomationRule() error = %v", err)
	}
	if updated.Name != "Updated consult" || !updated.CreatedAt.Equal(now) || !updated.UpdatedAt.Equal(updateInput.UpdatedAt) {
		t.Fatalf("updated rule = %#v", updated)
	}
	if err := store.PutAutomationRuleSessionOverride(ctx, automationrulebiz.SessionOverride{
		WorkspaceID: rule.WorkspaceID, AgentSessionID: "session-1", RuleIDs: []string{rule.ID}, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutAutomationRuleSessionOverride() error = %v", err)
	}
	override, found, err := store.GetAutomationRuleSessionOverride(ctx, rule.WorkspaceID, "session-1")
	if err != nil || !found || len(override.RuleIDs) != 1 || override.RuleIDs[0] != rule.ID {
		t.Fatalf("GetAutomationRuleSessionOverride() = %#v, %v", override, err)
	}
	if missing, found, err := store.GetAutomationRuleSessionOverride(ctx, rule.WorkspaceID, "missing"); err != nil || found || missing.AgentSessionID != "" {
		t.Fatalf("GetAutomationRuleSessionOverride(missing) = %#v, %v, %v", missing, found, err)
	}
	if err := store.DeleteAutomationRule(ctx, rule.WorkspaceID, rule.ID); err != nil {
		t.Fatalf("DeleteAutomationRule() error = %v", err)
	}
	if _, err := store.GetAutomationRule(ctx, rule.WorkspaceID, rule.ID); !errors.Is(err, ErrAutomationRuleNotFound) {
		t.Fatalf("GetAutomationRule() after delete error = %v", err)
	}
}

func TestAutomationRulesMigrationBackfillsBoundReviewPolicy(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createModelPlanTestWorkspace(t, store, "ws-legacy-automation")
	now := time.UnixMilli(1700000000000).UTC()
	if err := store.PutModelPlan(ctx, modelplanbiz.Plan{
		ID: "plan-review", WorkspaceID: "ws-legacy-automation", Name: "Review Plan",
		TemplateKind: modelplanbiz.TemplateCustom, Protocol: modelplanbiz.ProtocolOpenAI,
		Models: []modelplanbiz.Model{{ID: "reasoner", Name: "Reasoner"}}, DefaultModel: "reasoner",
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutModelPlan() error = %v", err)
	}
	if err := store.PutAgentModelBinding(ctx, modelbindingbiz.Binding{
		WorkspaceID: "ws-legacy-automation", AgentTargetID: "local:codex",
		ModelPlanID: "plan-review", DefaultModel: "reasoner", ModelPolicyID: "policy-review", UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutAgentModelBinding() error = %v", err)
	}
	if err := store.PutModelPolicy(ctx, modelpolicybiz.Policy{
		ID: "policy-review", WorkspaceID: "ws-legacy-automation", Name: "Legacy Review",
		Review:     modelpolicybiz.PlanModelRef{ModelPlanID: "plan-review", Model: "reasoner"},
		ReviewRule: modelpolicybiz.ReviewRule{Enabled: true, Trigger: modelpolicybiz.ReviewTriggerOnTaskComplete, MaxRunsPerSession: 2, MaxTotalTokensPerSession: 9000},
		CreatedAt:  now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutModelPolicy() error = %v", err)
	}
	if err := store.PutModelPolicy(ctx, modelpolicybiz.Policy{
		ID: "policy-no-review", WorkspaceID: "ws-legacy-automation", Name: "No Review",
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutModelPolicy(no review) error = %v", err)
	}
	if err := store.PutModelPolicySessionOverride(ctx, modelpolicybiz.SessionOverride{
		WorkspaceID: "ws-legacy-automation", AgentSessionID: "session-1", ModelPolicyID: "policy-review", UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutModelPolicySessionOverride() error = %v", err)
	}
	if err := store.PutModelPolicySessionOverride(ctx, modelpolicybiz.SessionOverride{
		WorkspaceID: "ws-legacy-automation", AgentSessionID: "session-no-review", ModelPolicyID: "policy-no-review", UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutModelPolicySessionOverride(no review) error = %v", err)
	}

	if _, err := store.writeDB.ExecContext(ctx, `DELETE FROM tuttid_schema_migrations WHERE id IN (?, ?, ?, ?, ?)`, schemaMigrationWorkspaceAgentsV1, schemaMigrationWorkspaceAgentsV2, schemaMigrationWorkspaceAgentsV3, schemaMigrationWorkspaceAgentsV4, schemaMigrationAutomationRulesV1); err != nil {
		t.Fatalf("reset migration markers error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `DROP TABLE workspace_agents; DROP TABLE automation_rule_session_overrides; DROP TABLE automation_rules;`); err != nil {
		t.Fatalf("drop migrated tables error = %v", err)
	}
	if err := store.applyWorkspaceAgentsV1(ctx); err != nil {
		t.Fatalf("applyWorkspaceAgentsV1() error = %v", err)
	}
	if err := store.applyWorkspaceAgentsV2(ctx); err != nil {
		t.Fatalf("applyWorkspaceAgentsV2() error = %v", err)
	}
	if err := store.applyWorkspaceAgentsV3(ctx); err != nil {
		t.Fatalf("applyWorkspaceAgentsV3() error = %v", err)
	}
	if err := store.applyWorkspaceAgentsV4(ctx); err != nil {
		t.Fatalf("applyWorkspaceAgentsV4() error = %v", err)
	}
	if err := store.applyAutomationRulesV1(ctx); err != nil {
		t.Fatalf("applyAutomationRulesV1() error = %v", err)
	}

	agentID := workspaceagentbiz.LegacyBindingID("ws-legacy-automation", "local:codex")
	if _, err := store.GetWorkspaceAgent(ctx, "ws-legacy-automation", agentID); err != nil {
		t.Fatalf("GetWorkspaceAgent(migrated) error = %v", err)
	}
	rules, err := store.ListAutomationRules(ctx, "ws-legacy-automation")
	if err != nil {
		t.Fatalf("ListAutomationRules() error = %v", err)
	}
	if len(rules) != 1 {
		t.Fatalf("migrated rules = %#v, want one", rules)
	}
	rule := rules[0]
	if rule.Action != automationrulebiz.ActionConsult || rule.SourceWorkspaceAgentID != agentID || rule.Target.ModelPlanID != "plan-review" || rule.Budget.MaxRunsPerSession != 2 {
		t.Fatalf("migrated rule = %#v", rule)
	}
	override, found, err := store.GetAutomationRuleSessionOverride(ctx, "ws-legacy-automation", "session-1")
	if err != nil || !found || len(override.RuleIDs) != 1 || override.RuleIDs[0] != rule.ID {
		t.Fatalf("migrated override = %#v, %v", override, err)
	}
	noReviewOverride, found, err := store.GetAutomationRuleSessionOverride(ctx, "ws-legacy-automation", "session-no-review")
	if err != nil || !found || !noReviewOverride.Disabled || len(noReviewOverride.RuleIDs) != 0 {
		t.Fatalf("migrated no-review override = %#v, %v", noReviewOverride, err)
	}
}
