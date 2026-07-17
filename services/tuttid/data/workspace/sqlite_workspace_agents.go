package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
)

// ErrWorkspaceAgentNotFound reports a missing workspace-scoped Agent.
var ErrWorkspaceAgentNotFound = errors.New("workspace agent not found")

func (s *SQLiteStore) ListWorkspaceAgents(ctx context.Context, workspaceID string) ([]workspaceagentbiz.Agent, error) {
	if s == nil || s.readDB == nil || s.writeDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	rows, err := s.readDB.QueryContext(ctx, `
SELECT workspace_id, agent_id, name, description, harness_agent_target_id,
       model_plan_id, default_model, instructions, call_conditions_json, capabilities_explicit, skills_json, tools_json,
       model_fallbacks_json, source, revision, created_at_unix_ms,
       updated_at_unix_ms
FROM workspace_agents
WHERE workspace_id = ?
ORDER BY updated_at_unix_ms DESC, name ASC, agent_id ASC
`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list workspace agents: %w", err)
	}
	defer rows.Close()

	agents := make([]workspaceagentbiz.Agent, 0)
	for rows.Next() {
		agent, err := scanWorkspaceAgent(rows)
		if err != nil {
			return nil, err
		}
		agents = append(agents, agent)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace agents: %w", err)
	}
	return agents, nil
}

func (s *SQLiteStore) ListWorkspaceAgentsByModelPlan(ctx context.Context, workspaceID string, modelPlanID string) ([]workspaceagentbiz.Agent, error) {
	agents, err := s.ListWorkspaceAgents(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	matched := make([]workspaceagentbiz.Agent, 0)
	for _, agent := range agents {
		usesPlan := agent.ModelPlanID == modelPlanID
		for _, fallback := range agent.ModelFallbacks {
			usesPlan = usesPlan || fallback.ModelPlanID == modelPlanID
		}
		if usesPlan {
			matched = append(matched, agent)
		}
	}
	return matched, nil
}

func (s *SQLiteStore) GetWorkspaceAgent(ctx context.Context, workspaceID string, agentID string) (workspaceagentbiz.Agent, error) {
	if s == nil || s.readDB == nil || s.writeDB == nil {
		return workspaceagentbiz.Agent{}, errors.New("workspace database is not initialized")
	}
	row := s.readDB.QueryRowContext(ctx, `
SELECT workspace_id, agent_id, name, description, harness_agent_target_id,
       model_plan_id, default_model, instructions, call_conditions_json, capabilities_explicit, skills_json, tools_json,
       model_fallbacks_json, source, revision, created_at_unix_ms,
       updated_at_unix_ms
FROM workspace_agents
WHERE workspace_id = ? AND agent_id = ?
`, workspaceID, agentID)
	agent, err := scanWorkspaceAgent(row)
	if errors.Is(err, sql.ErrNoRows) {
		return workspaceagentbiz.Agent{}, ErrWorkspaceAgentNotFound
	}
	if err != nil {
		return workspaceagentbiz.Agent{}, err
	}
	return agent, nil
}

func (s *SQLiteStore) PutWorkspaceAgent(ctx context.Context, agent workspaceagentbiz.Agent) error {
	if s == nil || s.readDB == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	normalized, err := workspaceagentbiz.Normalize(agent)
	if err != nil {
		return err
	}
	skillsJSON, err := encodeWorkspaceAgentStrings(normalized.Skills)
	if err != nil {
		return fmt.Errorf("encode workspace agent skills: %w", err)
	}
	toolsJSON, err := encodeWorkspaceAgentStrings(normalized.Tools)
	if err != nil {
		return fmt.Errorf("encode workspace agent tools: %w", err)
	}
	modelFallbacksJSON, err := json.Marshal(normalized.ModelFallbacks)
	if err != nil {
		return fmt.Errorf("encode workspace agent model fallbacks: %w", err)
	}
	callConditionsJSON, err := encodeWorkspaceAgentStrings(normalized.CallConditions)
	if err != nil {
		return fmt.Errorf("encode workspace agent call conditions: %w", err)
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO workspace_agents (
  workspace_id, agent_id, name, description, harness_agent_target_id,
  model_plan_id, default_model, instructions, call_conditions_json, capabilities_explicit, skills_json, tools_json,
  model_fallbacks_json, source, revision, created_at_unix_ms,
  updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_id) DO UPDATE SET
  name = excluded.name,
  description = excluded.description,
  harness_agent_target_id = excluded.harness_agent_target_id,
  model_plan_id = excluded.model_plan_id,
  default_model = excluded.default_model,
  instructions = excluded.instructions,
  call_conditions_json = excluded.call_conditions_json,
  capabilities_explicit = excluded.capabilities_explicit,
  skills_json = excluded.skills_json,
  tools_json = excluded.tools_json,
  model_fallbacks_json = excluded.model_fallbacks_json,
  source = excluded.source,
  revision = excluded.revision,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, normalized.WorkspaceID, normalized.ID, normalized.Name, normalized.Description,
		normalized.HarnessAgentTargetID, normalized.ModelPlanID, normalized.DefaultModel,
		normalized.Instructions, callConditionsJSON, normalized.CapabilitiesExplicit, skillsJSON, toolsJSON, string(modelFallbacksJSON),
		normalized.Source, normalized.Revision,
		unixMs(normalized.CreatedAt), unixMs(normalized.UpdatedAt))
	if err != nil {
		return fmt.Errorf("put workspace agent: %w", err)
	}
	return nil
}

func (s *SQLiteStore) DeleteWorkspaceAgent(ctx context.Context, workspaceID string, agentID string) error {
	if s == nil || s.readDB == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	result, err := s.writeDB.ExecContext(ctx, `
DELETE FROM workspace_agents
WHERE workspace_id = ? AND agent_id = ?
`, workspaceID, agentID)
	if err != nil {
		return fmt.Errorf("delete workspace agent: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete workspace agent rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrWorkspaceAgentNotFound
	}
	return nil
}

func scanWorkspaceAgent(row managedProviderScanner) (workspaceagentbiz.Agent, error) {
	var agent workspaceagentbiz.Agent
	var skillsJSON string
	var callConditionsJSON string
	var toolsJSON string
	var modelFallbacksJSON string
	var createdAtUnixMS int64
	var updatedAtUnixMS int64
	if err := row.Scan(
		&agent.WorkspaceID,
		&agent.ID,
		&agent.Name,
		&agent.Description,
		&agent.HarnessAgentTargetID,
		&agent.ModelPlanID,
		&agent.DefaultModel,
		&agent.Instructions,
		&callConditionsJSON,
		&agent.CapabilitiesExplicit,
		&skillsJSON,
		&toolsJSON,
		&modelFallbacksJSON,
		&agent.Source,
		&agent.Revision,
		&createdAtUnixMS,
		&updatedAtUnixMS,
	); err != nil {
		return workspaceagentbiz.Agent{}, err
	}
	if err := decodeWorkspaceAgentStrings(callConditionsJSON, &agent.CallConditions); err != nil {
		return workspaceagentbiz.Agent{}, fmt.Errorf("decode workspace agent call conditions: %w", err)
	}
	if err := decodeWorkspaceAgentStrings(skillsJSON, &agent.Skills); err != nil {
		return workspaceagentbiz.Agent{}, fmt.Errorf("decode workspace agent skills: %w", err)
	}
	if err := decodeWorkspaceAgentStrings(toolsJSON, &agent.Tools); err != nil {
		return workspaceagentbiz.Agent{}, fmt.Errorf("decode workspace agent tools: %w", err)
	}
	if err := json.Unmarshal([]byte(modelFallbacksJSON), &agent.ModelFallbacks); err != nil {
		return workspaceagentbiz.Agent{}, fmt.Errorf("decode workspace agent model fallbacks: %w", err)
	}
	agent.CreatedAt = time.UnixMilli(createdAtUnixMS).UTC()
	agent.UpdatedAt = time.UnixMilli(updatedAtUnixMS).UTC()
	return workspaceagentbiz.Clone(agent), nil
}

func encodeWorkspaceAgentStrings(values []string) (string, error) {
	encoded, err := json.Marshal(workspaceagentbiz.NormalizeStringList(values))
	return string(encoded), err
}

func decodeWorkspaceAgentStrings(encoded string, target *[]string) error {
	if encoded == "" {
		*target = []string{}
		return nil
	}
	if err := json.Unmarshal([]byte(encoded), target); err != nil {
		return err
	}
	*target = workspaceagentbiz.NormalizeStringList(*target)
	return nil
}
