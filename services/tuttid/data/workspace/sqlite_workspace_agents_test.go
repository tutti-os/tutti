package workspace

import (
	"context"
	"errors"
	"testing"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
)

func TestSQLiteStoreWorkspaceAgentRoundTrip(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-agents", Name: "Agents"}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	now := time.UnixMilli(1700000000000).UTC()
	agent := workspaceagentbiz.Agent{
		ID:                   "workspace-agent:one",
		WorkspaceID:          "ws-agents",
		Name:                 "Reviewer",
		Purpose:              "Review changes",
		HarnessAgentTargetID: agenttargetbiz.IDLocalCodex,
		ModelPlanID:          "mp-one",
		DefaultModel:         "gpt-5",
		ModelFallbacks: []workspaceagentbiz.ModelRef{{
			ModelPlanID: "mp-fallback",
			Model:       "gpt-4.1",
		}},
		Instructions:         "Be precise.",
		CallConditions:       []string{"Before release", " Before release "},
		CapabilitiesExplicit: true,
		Skills:               []string{"review", " review "},
		Tools:                []string{"git"},
		Permissions:          []string{"workspace-read"},
		Enabled:              true,
		Source:               workspaceagentbiz.SourceUser,
		Revision:             3,
		CreatedAt:            now,
		UpdatedAt:            now,
	}
	if err := store.PutWorkspaceAgent(ctx, agent); err != nil {
		t.Fatalf("PutWorkspaceAgent() error = %v", err)
	}

	loaded, err := store.GetWorkspaceAgent(ctx, "ws-agents", agent.ID)
	if err != nil {
		t.Fatalf("GetWorkspaceAgent() error = %v", err)
	}
	if loaded.Name != "Reviewer" || loaded.Revision != 3 || loaded.DefaultModel != "gpt-5" {
		t.Fatalf("GetWorkspaceAgent() = %#v", loaded)
	}
	if len(loaded.Skills) != 1 || loaded.Skills[0] != "review" {
		t.Fatalf("GetWorkspaceAgent() skills = %#v", loaded.Skills)
	}
	if !loaded.CapabilitiesExplicit {
		t.Fatal("GetWorkspaceAgent() lost explicit capability selection")
	}
	if len(loaded.CallConditions) != 1 || loaded.CallConditions[0] != "Before release" {
		t.Fatalf("GetWorkspaceAgent() call conditions = %#v", loaded.CallConditions)
	}
	if len(loaded.ModelFallbacks) != 1 || loaded.ModelFallbacks[0].ModelPlanID != "mp-fallback" {
		t.Fatalf("GetWorkspaceAgent() model fallbacks = %#v", loaded.ModelFallbacks)
	}
	byPlan, err := store.ListWorkspaceAgentsByModelPlan(ctx, "ws-agents", "mp-one")
	if err != nil || len(byPlan) != 1 {
		t.Fatalf("ListWorkspaceAgentsByModelPlan() = %#v, %v", byPlan, err)
	}
	byFallback, err := store.ListWorkspaceAgentsByModelPlan(ctx, "ws-agents", "mp-fallback")
	if err != nil || len(byFallback) != 1 {
		t.Fatalf("ListWorkspaceAgentsByModelPlan(fallback) = %#v, %v", byFallback, err)
	}
	listed, err := store.ListWorkspaceAgents(ctx, "ws-agents")
	if err != nil || len(listed) != 1 {
		t.Fatalf("ListWorkspaceAgents() = %#v, %v", listed, err)
	}

	if err := store.DeleteWorkspaceAgent(ctx, "ws-agents", agent.ID); err != nil {
		t.Fatalf("DeleteWorkspaceAgent() error = %v", err)
	}
	if _, err := store.GetWorkspaceAgent(ctx, "ws-agents", agent.ID); !errors.Is(err, ErrWorkspaceAgentNotFound) {
		t.Fatalf("GetWorkspaceAgent() after delete error = %v", err)
	}
	if err := store.DeleteWorkspaceAgent(ctx, "ws-agents", agent.ID); !errors.Is(err, ErrWorkspaceAgentNotFound) {
		t.Fatalf("DeleteWorkspaceAgent() second error = %v", err)
	}
}

func TestWorkspaceAgentsMigrationBackfillsLegacyBindingIdempotently(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-legacy-agent", Name: "Legacy"}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	now := time.UnixMilli(1700000000000).UTC()
	plan := modelplanbiz.Plan{
		ID:           "mp-legacy",
		WorkspaceID:  "ws-legacy-agent",
		Name:         "Team Plan",
		TemplateKind: modelplanbiz.TemplateCustom,
		Protocol:     modelplanbiz.ProtocolOpenAI,
		Models:       []modelplanbiz.Model{{ID: "gpt-5", Name: "GPT-5"}},
		DefaultModel: "gpt-5",
		Enabled:      true,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := store.PutModelPlan(ctx, plan); err != nil {
		t.Fatalf("PutModelPlan() error = %v", err)
	}
	if err := store.PutAgentModelBinding(ctx, modelbindingbiz.Binding{
		WorkspaceID:   "ws-legacy-agent",
		AgentTargetID: agenttargetbiz.IDLocalCodex,
		ModelPlanID:   plan.ID,
		UpdatedAt:     now,
	}); err != nil {
		t.Fatalf("PutAgentModelBinding() error = %v", err)
	}

	if _, err := store.db.ExecContext(ctx, `DELETE FROM tuttid_schema_migrations WHERE id IN (?, ?, ?, ?)`, schemaMigrationWorkspaceAgentsV1, schemaMigrationWorkspaceAgentsV2, schemaMigrationWorkspaceAgentsV3, schemaMigrationWorkspaceAgentsV4); err != nil {
		t.Fatalf("reset workspace agent migration error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `DROP TABLE workspace_agents`); err != nil {
		t.Fatalf("drop workspace_agents error = %v", err)
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
	if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agents SET skills_json = '["review"]'`); err != nil {
		t.Fatalf("seed pre-v4 workspace agent skills error = %v", err)
	}
	if err := store.applyWorkspaceAgentsV4(ctx); err != nil {
		t.Fatalf("applyWorkspaceAgentsV4() error = %v", err)
	}
	if err := store.applyWorkspaceAgentsV1(ctx); err != nil {
		t.Fatalf("applyWorkspaceAgentsV1() idempotent error = %v", err)
	}

	agents, err := store.ListWorkspaceAgents(ctx, "ws-legacy-agent")
	if err != nil {
		t.Fatalf("ListWorkspaceAgents() error = %v", err)
	}
	if len(agents) != 1 {
		t.Fatalf("ListWorkspaceAgents() len = %d, want 1", len(agents))
	}
	agent := agents[0]
	if agent.ID != workspaceagentbiz.LegacyBindingID("ws-legacy-agent", agenttargetbiz.IDLocalCodex) {
		t.Fatalf("backfilled id = %q", agent.ID)
	}
	if agent.Name != "Codex · Team Plan" || agent.Source != workspaceagentbiz.SourceLegacyBinding {
		t.Fatalf("backfilled identity = %#v", agent)
	}
	if !agent.CapabilitiesExplicit {
		t.Fatal("v4 migration did not preserve the existing explicit skill selection")
	}
	if agent.ModelPlanID != "mp-legacy" || agent.DefaultModel != "gpt-5" || agent.Revision != 1 {
		t.Fatalf("backfilled model config = %#v", agent)
	}
}
