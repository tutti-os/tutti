package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
)

var ErrAutomationRuleNotFound = errors.New("automation rule not found")
var ErrAutomationRuleAlreadyExists = errors.New("automation rule already exists")

func (s *SQLiteStore) ListAutomationRules(ctx context.Context, workspaceID string) ([]automationrulebiz.Rule, error) {
	rows, err := s.readDB.QueryContext(ctx, automationRuleSelect+`
WHERE workspace_id = ?
ORDER BY created_at_unix_ms ASC, rule_id ASC
`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list automation rules: %w", err)
	}
	defer rows.Close()
	var rules []automationrulebiz.Rule
	for rows.Next() {
		rule, err := scanAutomationRule(rows)
		if err != nil {
			return nil, err
		}
		rules = append(rules, rule)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate automation rules: %w", err)
	}
	return rules, nil
}

func (s *SQLiteStore) GetAutomationRule(ctx context.Context, workspaceID string, ruleID string) (automationrulebiz.Rule, error) {
	rule, err := scanAutomationRule(s.readDB.QueryRowContext(ctx, automationRuleSelect+`
WHERE workspace_id = ? AND rule_id = ?
`, workspaceID, ruleID))
	if errors.Is(err, sql.ErrNoRows) {
		return automationrulebiz.Rule{}, ErrAutomationRuleNotFound
	}
	return rule, err
}

func (s *SQLiteStore) CreateAutomationRule(ctx context.Context, rule automationrulebiz.Rule) error {
	normalized, err := automationrulebiz.Normalize(rule)
	if err != nil {
		return err
	}
	requiredCapabilities, err := json.Marshal(normalized.Target.RequiredCapabilities)
	if err != nil {
		return fmt.Errorf("encode automation rule capabilities: %w", err)
	}
	allowedTools, err := json.Marshal(normalized.Permissions.AllowedTools)
	if err != nil {
		return fmt.Errorf("encode automation rule tools: %w", err)
	}
	// The action column is retired: automation has exactly one launch
	// behavior, so rows no longer carry an action discriminator.
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO automation_rules (
  workspace_id, rule_id, name, enabled, trigger, action,
  source_workspace_agent_id, target_kind, target_workspace_agent_id,
  model_plan_id, model, required_capabilities_json, permission_mode_id,
  allowed_tools_json, max_runs_per_session, max_total_tokens_per_session,
  prompt, legacy_policy_id, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
`, normalized.WorkspaceID, normalized.ID, normalized.Name, boolInt(normalized.Enabled),
		string(normalized.Trigger), normalized.SourceWorkspaceAgentID,
		string(normalized.Target.Kind), normalized.Target.WorkspaceAgentID,
		normalized.Target.ModelPlanID, normalized.Target.Model, string(requiredCapabilities),
		normalized.Permissions.PermissionModeID, string(allowedTools),
		normalized.Budget.MaxRunsPerSession, normalized.Budget.MaxTotalTokensPerSession,
		normalized.Prompt, unixMs(normalized.CreatedAt), unixMs(normalized.UpdatedAt))
	if err != nil {
		if isSQLiteUniqueConstraintError(err) {
			return ErrAutomationRuleAlreadyExists
		}
		return fmt.Errorf("create automation rule: %w", err)
	}
	return nil
}

func (s *SQLiteStore) UpdateAutomationRule(ctx context.Context, rule automationrulebiz.Rule) (automationrulebiz.Rule, error) {
	normalized, err := automationrulebiz.Normalize(rule)
	if err != nil {
		return automationrulebiz.Rule{}, err
	}
	requiredCapabilities, err := json.Marshal(normalized.Target.RequiredCapabilities)
	if err != nil {
		return automationrulebiz.Rule{}, fmt.Errorf("encode automation rule capabilities: %w", err)
	}
	allowedTools, err := json.Marshal(normalized.Permissions.AllowedTools)
	if err != nil {
		return automationrulebiz.Rule{}, fmt.Errorf("encode automation rule tools: %w", err)
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return automationrulebiz.Rule{}, fmt.Errorf("begin automation rule update: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()
	result, err := tx.ExecContext(ctx, `
UPDATE automation_rules
SET name = ?, enabled = ?, trigger = ?, action = '',
    source_workspace_agent_id = ?, target_kind = ?, target_workspace_agent_id = ?,
    model_plan_id = ?, model = ?, required_capabilities_json = ?,
    permission_mode_id = ?, allowed_tools_json = ?, max_runs_per_session = ?,
    max_total_tokens_per_session = ?, prompt = ?, legacy_policy_id = '',
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND rule_id = ?
`, normalized.Name, boolInt(normalized.Enabled), string(normalized.Trigger),
		normalized.SourceWorkspaceAgentID, string(normalized.Target.Kind), normalized.Target.WorkspaceAgentID,
		normalized.Target.ModelPlanID, normalized.Target.Model, string(requiredCapabilities),
		normalized.Permissions.PermissionModeID, string(allowedTools), normalized.Budget.MaxRunsPerSession,
		normalized.Budget.MaxTotalTokensPerSession, normalized.Prompt, unixMs(normalized.UpdatedAt),
		normalized.WorkspaceID, normalized.ID)
	if err != nil {
		return automationrulebiz.Rule{}, fmt.Errorf("update automation rule: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return automationrulebiz.Rule{}, fmt.Errorf("update automation rule result: %w", err)
	}
	if affected == 0 {
		return automationrulebiz.Rule{}, ErrAutomationRuleNotFound
	}
	updated, err := scanAutomationRule(tx.QueryRowContext(ctx, automationRuleSelect+`
WHERE workspace_id = ? AND rule_id = ?
`, normalized.WorkspaceID, normalized.ID))
	if err != nil {
		return automationrulebiz.Rule{}, fmt.Errorf("read updated automation rule: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return automationrulebiz.Rule{}, fmt.Errorf("commit automation rule update: %w", err)
	}
	return updated, nil
}

func (s *SQLiteStore) DeleteAutomationRule(ctx context.Context, workspaceID string, ruleID string) error {
	result, err := s.writeDB.ExecContext(ctx, `DELETE FROM automation_rules WHERE workspace_id = ? AND rule_id = ?`, workspaceID, ruleID)
	if err != nil {
		return fmt.Errorf("delete automation rule: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete automation rule result: %w", err)
	}
	if affected == 0 {
		return ErrAutomationRuleNotFound
	}
	return nil
}

func (s *SQLiteStore) ListAutomationRulesByPlan(ctx context.Context, workspaceID string, planID string) ([]automationrulebiz.Rule, error) {
	rows, err := s.readDB.QueryContext(ctx, automationRuleSelect+`
WHERE workspace_id = ? AND model_plan_id = ?
ORDER BY rule_id ASC
`, workspaceID, planID)
	if err != nil {
		return nil, fmt.Errorf("list automation rules by plan: %w", err)
	}
	defer rows.Close()
	var rules []automationrulebiz.Rule
	for rows.Next() {
		rule, err := scanAutomationRule(rows)
		if err != nil {
			return nil, err
		}
		rules = append(rules, rule)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate automation rules by plan: %w", err)
	}
	return rules, nil
}

func (s *SQLiteStore) GetAutomationRuleSessionOverride(ctx context.Context, workspaceID string, sessionID string) (automationrulebiz.SessionOverride, bool, error) {
	row := s.readDB.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, disabled, rule_ids_json, updated_at_unix_ms
FROM automation_rule_session_overrides
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, sessionID)
	var override automationrulebiz.SessionOverride
	var disabled int
	var ruleIDsJSON string
	var updatedAtMS int64
	if err := row.Scan(&override.WorkspaceID, &override.AgentSessionID, &disabled, &ruleIDsJSON, &updatedAtMS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return automationrulebiz.SessionOverride{}, false, nil
		}
		return automationrulebiz.SessionOverride{}, false, err
	}
	if err := json.Unmarshal([]byte(ruleIDsJSON), &override.RuleIDs); err != nil {
		return automationrulebiz.SessionOverride{}, false, fmt.Errorf("decode automation rule override ids: %w", err)
	}
	override.Disabled = disabled != 0
	override.UpdatedAt = time.UnixMilli(updatedAtMS).UTC()
	return override, true, nil
}

func (s *SQLiteStore) PutAutomationRuleSessionOverride(ctx context.Context, override automationrulebiz.SessionOverride) error {
	normalized, err := automationrulebiz.NormalizeSessionOverride(override)
	if err != nil {
		return err
	}
	ruleIDs, err := json.Marshal(normalized.RuleIDs)
	if err != nil {
		return fmt.Errorf("encode automation rule override ids: %w", err)
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO automation_rule_session_overrides (
  workspace_id, agent_session_id, disabled, rule_ids_json, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id) DO UPDATE SET
  disabled = excluded.disabled,
  rule_ids_json = excluded.rule_ids_json,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, normalized.WorkspaceID, normalized.AgentSessionID, boolInt(normalized.Disabled), string(ruleIDs), unixMs(normalized.UpdatedAt))
	if err != nil {
		return fmt.Errorf("put automation rule session override: %w", err)
	}
	return nil
}

const automationRuleSelect = `
SELECT workspace_id, rule_id, name, enabled, trigger,
  source_workspace_agent_id, target_kind, target_workspace_agent_id,
  model_plan_id, model, required_capabilities_json, permission_mode_id,
  allowed_tools_json, max_runs_per_session, max_total_tokens_per_session,
  prompt, created_at_unix_ms, updated_at_unix_ms
FROM automation_rules
`

func scanAutomationRule(row managedProviderScanner) (automationrulebiz.Rule, error) {
	var rule automationrulebiz.Rule
	var enabled int
	var trigger, targetKind string
	var requiredCapabilitiesJSON, allowedToolsJSON string
	var createdAtMS, updatedAtMS int64
	if err := row.Scan(&rule.WorkspaceID, &rule.ID, &rule.Name, &enabled, &trigger,
		&rule.SourceWorkspaceAgentID, &targetKind, &rule.Target.WorkspaceAgentID,
		&rule.Target.ModelPlanID, &rule.Target.Model, &requiredCapabilitiesJSON,
		&rule.Permissions.PermissionModeID, &allowedToolsJSON,
		&rule.Budget.MaxRunsPerSession, &rule.Budget.MaxTotalTokensPerSession,
		&rule.Prompt, &createdAtMS, &updatedAtMS); err != nil {
		return automationrulebiz.Rule{}, err
	}
	if err := json.Unmarshal([]byte(requiredCapabilitiesJSON), &rule.Target.RequiredCapabilities); err != nil {
		return automationrulebiz.Rule{}, fmt.Errorf("decode automation rule capabilities: %w", err)
	}
	if err := json.Unmarshal([]byte(allowedToolsJSON), &rule.Permissions.AllowedTools); err != nil {
		return automationrulebiz.Rule{}, fmt.Errorf("decode automation rule tools: %w", err)
	}
	rule.Enabled = enabled != 0
	rule.Trigger = automationrulebiz.Trigger(trigger)
	rule.Target.Kind = automationrulebiz.TargetKind(targetKind)
	rule.CreatedAt = time.UnixMilli(createdAtMS).UTC()
	rule.UpdatedAt = time.UnixMilli(updatedAtMS).UTC()
	return automationrulebiz.Normalize(rule)
}
