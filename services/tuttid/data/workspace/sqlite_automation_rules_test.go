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
		ID: "automation-rule:one", WorkspaceID: "ws-automation", Name: "Launch after completion",
		Enabled: true,
		Target:  automationrulebiz.Target{WorkspaceAgentID: "workspace-agent:reviewer"},
		Permissions: automationrulebiz.PermissionPolicy{
			PermissionModeID: "workspace-write",
			AllowedTools:     []string{"terminal"},
		},
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
	if loaded.Target.WorkspaceAgentID != "workspace-agent:reviewer" ||
		loaded.Permissions.PermissionModeID != "workspace-write" ||
		loaded.Budget.MaxRunsPerSession != 2 {
		t.Fatalf("loaded rule = %#v", loaded)
	}
	updateInput := loaded
	updateInput.Name = "Updated launch"
	updateInput.UpdatedAt = now.Add(time.Minute)
	updated, err := store.UpdateAutomationRule(ctx, updateInput)
	if err != nil {
		t.Fatalf("UpdateAutomationRule() error = %v", err)
	}
	if updated.Name != "Updated launch" || !updated.CreatedAt.Equal(now) || !updated.UpdatedAt.Equal(updateInput.UpdatedAt) {
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

func TestSQLiteStoreAutomationRuleExecutionLedger(t *testing.T) {
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createModelPlanTestWorkspace(t, store, "ws-executions")

	execution := automationrulebiz.Execution{
		WorkspaceID:     "ws-executions",
		RuleID:          "rule-1",
		SourceSessionID: "session-src",
		TriggerID:       "turn-1",
		TargetSessionID: "session-target",
	}
	if err := store.RecordAutomationRuleExecution(ctx, execution); err != nil {
		t.Fatalf("RecordAutomationRuleExecution() error = %v", err)
	}
	if err := store.RecordAutomationRuleExecution(ctx, execution); err == nil {
		t.Fatal("RecordAutomationRuleExecution() duplicate trigger must fail")
	}

	exists, err := store.AutomationRuleExecutionExists(ctx, "ws-executions", "session-src", "rule-1", "turn-1")
	if err != nil || !exists {
		t.Fatalf("AutomationRuleExecutionExists() = %v, %v", exists, err)
	}
	exists, err = store.AutomationRuleExecutionExists(ctx, "ws-executions", "session-src", "rule-1", "turn-2")
	if err != nil || exists {
		t.Fatalf("AutomationRuleExecutionExists(other turn) = %v, %v", exists, err)
	}

	if err := store.RecordAutomationTargetUsage(ctx, "ws-executions", "session-target", 1234); err != nil {
		t.Fatalf("RecordAutomationTargetUsage() error = %v", err)
	}
	// The settle-once contract ignores later, larger totals.
	if err := store.RecordAutomationTargetUsage(ctx, "ws-executions", "session-target", 99999); err != nil {
		t.Fatalf("RecordAutomationTargetUsage(second) error = %v", err)
	}
	runs, tokens, err := store.AutomationRuleUsage(ctx, "ws-executions", "session-src", "rule-1")
	if err != nil || runs != 1 || tokens != 1234 {
		t.Fatalf("AutomationRuleUsage() = %d runs, %d tokens, %v", runs, tokens, err)
	}

	second := execution
	second.TriggerID = "turn-2"
	second.TargetSessionID = "session-target-2"
	if err := store.RecordAutomationRuleExecution(ctx, second); err != nil {
		t.Fatalf("RecordAutomationRuleExecution(second) error = %v", err)
	}
	if err := store.MarkAutomationRuleExecutionLaunchFailed(ctx, "ws-executions", "session-target-2", "boom"); err != nil {
		t.Fatalf("MarkAutomationRuleExecutionLaunchFailed() error = %v", err)
	}
	// Failed launches still count toward the per-source-session run budget.
	runs, _, err = store.AutomationRuleUsage(ctx, "ws-executions", "session-src", "rule-1")
	if err != nil || runs != 2 {
		t.Fatalf("AutomationRuleUsage(after failure) = %d runs, %v", runs, err)
	}
}

func TestAutomationRulesMigrationRetiresConsultRowsAndKeepsAgentLaunches(t *testing.T) {
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
	if err := store.PutModelPolicy(ctx, modelpolicybiz.Policy{
		ID: "policy-review", WorkspaceID: "ws-legacy-automation", Name: "Legacy Review",
		Review:     modelpolicybiz.PlanModelRef{ModelPlanID: "plan-review", Model: "reasoner"},
		ReviewRule: modelpolicybiz.ReviewRule{Enabled: true, Trigger: modelpolicybiz.ReviewTriggerOnTaskComplete, MaxRunsPerSession: 2, MaxTotalTokensPerSession: 9000},
		CreatedAt:  now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutModelPolicy() error = %v", err)
	}
	if err := store.PutAgentModelBinding(ctx, modelbindingbiz.Binding{
		WorkspaceID: "ws-legacy-automation", AgentTargetID: "local:codex",
		ModelPlanID: "plan-review", DefaultModel: "reasoner", ModelPolicyID: "policy-review", UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutAgentModelBinding() error = %v", err)
	}

	// Reset to a pre-v1 state, then replay v1 (which backfills a legacy
	// consult row) plus a surviving agent-target row, and verify v2
	// normalizes storage to the single launch semantic.
	if _, err := store.writeDB.ExecContext(ctx, `DELETE FROM tuttid_schema_migrations WHERE id IN (?, ?, ?, ?, ?, ?, ?)`, schemaMigrationWorkspaceAgentsV1, schemaMigrationWorkspaceAgentsV2, schemaMigrationWorkspaceAgentsV3, schemaMigrationWorkspaceAgentsV4, schemaMigrationWorkspaceAgentsV5, schemaMigrationAutomationRulesV1, schemaMigrationAutomationRulesV2); err != nil {
		t.Fatalf("reset migration markers error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `DROP TABLE workspace_agents; DROP TABLE automation_rule_session_overrides; DROP TABLE automation_rules; DROP TABLE automation_rule_executions;`); err != nil {
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
	if err := store.applyWorkspaceAgentsV5(ctx); err != nil {
		t.Fatalf("applyWorkspaceAgentsV5() error = %v", err)
	}
	if err := store.applyAutomationRulesV1(ctx); err != nil {
		t.Fatalf("applyAutomationRulesV1() error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
INSERT INTO automation_rules (
  workspace_id, rule_id, name, enabled, trigger, action,
  source_workspace_agent_id, target_kind, target_workspace_agent_id,
  model_plan_id, model, required_capabilities_json, permission_mode_id,
  allowed_tools_json, max_runs_per_session, max_total_tokens_per_session,
  prompt, legacy_policy_id, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-legacy-automation', 'automation-rule:launch', 'Escalate', 1, 'on_task_failed', 'delegate',
  '', 'agent', 'workspace-agent:stronger', '', '', '[]', '', '[]', 1, 20000, 'Rescue it.', '', ?, ?)
`, unixMs(now), unixMs(now)); err != nil {
		t.Fatalf("seed legacy delegate rule error = %v", err)
	}
	if err := store.applyAutomationRulesV2(ctx); err != nil {
		t.Fatalf("applyAutomationRulesV2() error = %v", err)
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
		t.Fatalf("post-v2 rules = %#v, want only the agent-target launch rule", rules)
	}
	rule := rules[0]
	if rule.ID != "automation-rule:launch" || rule.Target.WorkspaceAgentID != "workspace-agent:stronger" ||
		rule.Trigger != automationrulebiz.TriggerOnTaskFailed || rule.Target.Kind != automationrulebiz.TargetAgent {
		t.Fatalf("post-v2 rule = %#v", rule)
	}
	// The v2 executions ledger must exist after replay.
	if _, _, err := store.AutomationRuleUsage(ctx, "ws-legacy-automation", "session-x", "rule-x"); err != nil {
		t.Fatalf("AutomationRuleUsage(after v2) error = %v", err)
	}
}
