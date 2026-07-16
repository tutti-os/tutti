package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
)

const schemaMigrationAutomationRulesV1 = "automation_rules_v1"

const migratedReviewPrompt = "Review the work this coding agent session just claimed to complete. Judge whether the claimed outcome is plausible and internally consistent. Answer with your findings, then end with exactly one final line: VERDICT: PASS or VERDICT: FAIL."

func (s *SQLiteStore) applyAutomationRulesV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAutomationRulesV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin automation rules v1 migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS automation_rules (
  workspace_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  trigger TEXT NOT NULL,
  action TEXT NOT NULL,
  source_workspace_agent_id TEXT NOT NULL DEFAULT '',
  target_kind TEXT NOT NULL,
  target_workspace_agent_id TEXT NOT NULL DEFAULT '',
  model_plan_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  required_capabilities_json TEXT NOT NULL DEFAULT '[]',
  permission_mode_id TEXT NOT NULL DEFAULT '',
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  max_runs_per_session INTEGER NOT NULL DEFAULT 0,
  max_total_tokens_per_session INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL DEFAULT '',
  legacy_policy_id TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, rule_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_automation_rules_workspace
  ON automation_rules(workspace_id, enabled DESC, updated_at_unix_ms DESC, rule_id ASC);
CREATE INDEX IF NOT EXISTS idx_automation_rules_model_plan
  ON automation_rules(workspace_id, model_plan_id);
CREATE INDEX IF NOT EXISTS idx_automation_rules_source_agent
  ON automation_rules(workspace_id, source_workspace_agent_id);

CREATE TABLE IF NOT EXISTS automation_rule_session_overrides (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  rule_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
`); err != nil {
		return fmt.Errorf("create automation rules v1 schema: %w", err)
	}
	legacyRules, err := backfillAutomationRulesFromPolicies(ctx, tx)
	if err != nil {
		return err
	}
	if err := backfillAutomationRuleOverrides(ctx, tx, legacyRules); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationAutomationRulesV1, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record automation rules v1 migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit automation rules v1 migration: %w", err)
	}
	return nil
}

type legacyAutomationRule struct {
	workspaceID string
	policyID    string
	ruleID      string
}

func backfillAutomationRulesFromPolicies(ctx context.Context, tx *sql.Tx) ([]legacyAutomationRule, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT p.workspace_id, p.policy_id, p.name, p.review_plan_id, p.review_model,
       p.review_rule_trigger, p.review_rule_max_runs,
       p.review_rule_max_total_tokens, p.created_at_unix_ms,
       p.updated_at_unix_ms, b.agent_target_id
FROM model_usage_policies AS p
JOIN agent_target_model_bindings AS b
  ON b.workspace_id = p.workspace_id AND b.model_policy_id = p.policy_id
WHERE p.review_rule_enabled = 1 AND p.review_plan_id <> ''
ORDER BY p.workspace_id ASC, p.policy_id ASC, b.agent_target_id ASC
`)
	if err != nil {
		return nil, fmt.Errorf("read legacy model review policies: %w", err)
	}
	defer rows.Close()
	var migrated []legacyAutomationRule
	for rows.Next() {
		var workspaceID, policyID, name, planID, model, trigger, harnessTargetID string
		var maxRuns int
		var maxTokens, createdAtMS, updatedAtMS int64
		if err := rows.Scan(&workspaceID, &policyID, &name, &planID, &model, &trigger, &maxRuns, &maxTokens, &createdAtMS, &updatedAtMS, &harnessTargetID); err != nil {
			return nil, fmt.Errorf("scan legacy model review policy: %w", err)
		}
		sourceAgentID := workspaceagentbiz.LegacyBindingID(workspaceID, harnessTargetID)
		ruleID := automationrulebiz.LegacyPolicyRuleID(workspaceID, policyID, sourceAgentID)
		if strings.TrimSpace(trigger) == "" {
			trigger = string(automationrulebiz.TriggerOnTaskComplete)
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO automation_rules (
  workspace_id, rule_id, name, enabled, trigger, action,
  source_workspace_agent_id, target_kind, target_workspace_agent_id,
  model_plan_id, model, required_capabilities_json, permission_mode_id,
  allowed_tools_json, max_runs_per_session, max_total_tokens_per_session,
  prompt, legacy_policy_id, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, 1, ?, 'consult', ?, 'model', '', ?, ?, '[]', '', '[]', ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, rule_id) DO NOTHING
`, workspaceID, ruleID, strings.TrimSpace(name)+" · Automated consult", trigger,
			sourceAgentID, planID, model, maxRuns, maxTokens, migratedReviewPrompt,
			policyID, createdAtMS, updatedAtMS); err != nil {
			return nil, fmt.Errorf("backfill automation rule from policy %q: %w", policyID, err)
		}
		migrated = append(migrated, legacyAutomationRule{workspaceID: workspaceID, policyID: policyID, ruleID: ruleID})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate legacy model review policies: %w", err)
	}
	return migrated, nil
}

func backfillAutomationRuleOverrides(ctx context.Context, tx *sql.Tx, rules []legacyAutomationRule) error {
	byPolicy := make(map[string][]string)
	for _, rule := range rules {
		key := rule.workspaceID + "\x00" + rule.policyID
		byPolicy[key] = append(byPolicy[key], rule.ruleID)
	}
	rows, err := tx.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, disabled, model_policy_id, updated_at_unix_ms
FROM model_policy_session_overrides
ORDER BY workspace_id ASC, agent_session_id ASC
`)
	if err != nil {
		return fmt.Errorf("read legacy policy session overrides: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var workspaceID, sessionID, policyID string
		var disabled int
		var updatedAtMS int64
		if err := rows.Scan(&workspaceID, &sessionID, &disabled, &policyID, &updatedAtMS); err != nil {
			return fmt.Errorf("scan legacy policy session override: %w", err)
		}
		ruleIDs := byPolicy[workspaceID+"\x00"+policyID]
		// A legacy override that explicitly selected a policy with no migrated
		// review rule meant "no review automation". An empty AutomationRule id
		// list otherwise means "use all workspace rules", so preserve the old
		// behavior by migrating that case as disabled.
		migratedDisabled := disabled != 0 || (strings.TrimSpace(policyID) != "" && len(ruleIDs) == 0)
		encoded, err := json.Marshal(ruleIDs)
		if err != nil {
			return fmt.Errorf("encode migrated automation rule ids: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO automation_rule_session_overrides (
  workspace_id, agent_session_id, disabled, rule_ids_json, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id) DO NOTHING
`, workspaceID, sessionID, boolInt(migratedDisabled), string(encoded), updatedAtMS); err != nil {
			return fmt.Errorf("backfill automation rule session override: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate legacy policy session overrides: %w", err)
	}
	return nil
}
