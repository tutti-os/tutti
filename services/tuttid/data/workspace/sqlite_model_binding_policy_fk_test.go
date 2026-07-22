package workspace

import (
	"context"
	"errors"
	"testing"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	modelpolicybiz "github.com/tutti-os/tutti/services/tuttid/biz/modelpolicy"
)

func seedFKPlan(t *testing.T, store *SQLiteStore, workspaceID, planID string, now time.Time) {
	t.Helper()
	if err := store.PutModelPlan(context.Background(), modelplanbiz.Plan{
		ID: planID, WorkspaceID: workspaceID, Name: planID, TemplateKind: modelplanbiz.TemplateCustom,
		Protocol: modelplanbiz.ProtocolOpenAI, Models: []modelplanbiz.Model{{ID: "m", Name: "M"}},
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutModelPlan(%s) error = %v", planID, err)
	}
}

func seedFKPolicy(t *testing.T, store *SQLiteStore, workspaceID, policyID string, now time.Time) {
	t.Helper()
	if err := store.PutModelPolicy(context.Background(), modelpolicybiz.Policy{
		ID: policyID, WorkspaceID: workspaceID, Name: policyID, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutModelPolicy(%s) error = %v", policyID, err)
	}
}

// TestBindingPolicyForeignKeyRejectsUnknownPolicy proves the insert side of the
// referential integrity: the database itself rejects a binding referencing a
// policy that does not exist, independent of any service-layer pre-check.
func TestBindingPolicyForeignKeyRejectsUnknownPolicy(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createModelPlanTestWorkspace(t, store, "ws")
	now := time.UnixMilli(1700000000000).UTC()
	seedFKPlan(t, store, "ws", "mp-1", now)

	err := store.PutAgentModelBinding(ctx, modelbindingbiz.Binding{
		WorkspaceID: "ws", AgentTargetID: agenttargetbiz.IDLocalCodex,
		ModelPlanID: "mp-1", ModelPolicyID: "pol-missing", UpdatedAt: now,
	})
	if !errors.Is(err, ErrAgentModelBindingReferenceInvalid) {
		t.Fatalf("PutAgentModelBinding(unknown policy) error = %v, want ErrAgentModelBindingReferenceInvalid", err)
	}
}

// TestPolicyOnlyAndPlanlessBindingsPersist proves the nullable links: a binding
// may reference a policy without a plan (and a plan without a policy), and both
// links read back correctly.
func TestPolicyOnlyAndPlanlessBindingsPersist(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createModelPlanTestWorkspace(t, store, "ws")
	now := time.UnixMilli(1700000000000).UTC()
	seedFKPlan(t, store, "ws", "mp-1", now)
	seedFKPolicy(t, store, "ws", "pol-1", now)

	// Policy-only binding: no plan link at all.
	if err := store.PutAgentModelBinding(ctx, modelbindingbiz.Binding{
		WorkspaceID: "ws", AgentTargetID: agenttargetbiz.IDLocalCodex,
		ModelPolicyID: "pol-1", UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutAgentModelBinding(policy-only) error = %v", err)
	}
	policyOnly, err := store.GetAgentModelBinding(ctx, "ws", agenttargetbiz.IDLocalCodex)
	if err != nil {
		t.Fatalf("GetAgentModelBinding(policy-only) error = %v", err)
	}
	if policyOnly.ModelPlanID != "" || policyOnly.ModelPolicyID != "pol-1" {
		t.Fatalf("policy-only binding = %#v, want empty plan and pol-1", policyOnly)
	}

	// Plan-only binding: no policy link; the policy id must read back as "".
	if err := store.PutAgentModelBinding(ctx, modelbindingbiz.Binding{
		WorkspaceID: "ws", AgentTargetID: agenttargetbiz.IDLocalClaudeCode,
		ModelPlanID: "mp-1", UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutAgentModelBinding(plan-only) error = %v", err)
	}
	planOnly, err := store.GetAgentModelBinding(ctx, "ws", agenttargetbiz.IDLocalClaudeCode)
	if err != nil {
		t.Fatalf("GetAgentModelBinding(plan-only) error = %v", err)
	}
	if planOnly.ModelPlanID != "mp-1" || planOnly.ModelPolicyID != "" {
		t.Fatalf("plan-only binding = %#v, want mp-1 and empty policy", planOnly)
	}

	// The list surface also survives NULL columns.
	all, err := store.ListAgentModelBindings(ctx, "ws")
	if err != nil {
		t.Fatalf("ListAgentModelBindings() error = %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("bindings = %#v, want 2", all)
	}
}

// TestDeleteModelPolicyRestrictedByBinding proves the delete side: the ON DELETE
// RESTRICT foreign key blocks deleting a policy while a binding references it,
// surfacing a typed ErrModelPolicyReferenced (which the service maps to a 409),
// and deletion proceeds once the binding is cleared.
func TestDeleteModelPolicyRestrictedByBinding(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createModelPlanTestWorkspace(t, store, "ws")
	now := time.UnixMilli(1700000000000).UTC()
	seedFKPlan(t, store, "ws", "mp-1", now)
	seedFKPolicy(t, store, "ws", "pol-1", now)
	if err := store.PutAgentModelBinding(ctx, modelbindingbiz.Binding{
		WorkspaceID: "ws", AgentTargetID: agenttargetbiz.IDLocalCodex,
		ModelPlanID: "mp-1", ModelPolicyID: "pol-1", UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutAgentModelBinding() error = %v", err)
	}

	if err := store.DeleteModelPolicy(ctx, "ws", "pol-1"); !errors.Is(err, ErrModelPolicyReferenced) {
		t.Fatalf("DeleteModelPolicy(referenced) error = %v, want ErrModelPolicyReferenced", err)
	}
	if _, err := store.GetModelPolicy(ctx, "ws", "pol-1"); err != nil {
		t.Fatalf("policy must survive a blocked deletion: %v", err)
	}

	// Clear the binding's policy link; deletion now proceeds.
	if err := store.PutAgentModelBinding(ctx, modelbindingbiz.Binding{
		WorkspaceID: "ws", AgentTargetID: agenttargetbiz.IDLocalCodex,
		ModelPlanID: "mp-1", UpdatedAt: now,
	}); err != nil {
		t.Fatalf("rebind (clear policy) error = %v", err)
	}
	if err := store.DeleteModelPolicy(ctx, "ws", "pol-1"); err != nil {
		t.Fatalf("DeleteModelPolicy(after clear) error = %v", err)
	}
	if _, err := store.GetModelPolicy(ctx, "ws", "pol-1"); !errors.Is(err, ErrModelPolicyNotFound) {
		t.Fatalf("policy should be deleted: %v", err)
	}
}
