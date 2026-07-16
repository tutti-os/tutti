package workspace

import (
	"context"
	"testing"
	"time"

	managedcredentialsbiz "github.com/tutti-os/tutti/services/tuttid/biz/managedcredentials"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestSQLiteStoreManagedGrantPersistsModelPlanReferences(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-grant", Name: "Grant Workspace"}); err != nil {
		t.Fatalf("Create workspace: %v", err)
	}
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	grant := managedcredentialsbiz.Grant{
		WorkspaceID:  "ws-grant",
		AppID:        "app-one",
		GrantRef:     "grant-one",
		ProviderIDs:  []managedcredentialsbiz.ProviderID{managedcredentialsbiz.ProviderOpenAI},
		ModelPlanIDs: []string{"plan-one", "plan-two"},
		Scopes:       []string{"model:invoke"},
		CreatedAt:    now,
		ExpiresAt:    now.Add(time.Hour),
	}
	if err := store.PutManagedModelGrant(ctx, grant); err != nil {
		t.Fatalf("PutManagedModelGrant: %v", err)
	}

	loaded, err := store.GetManagedModelGrant(ctx, "ws-grant", "app-one", "grant-one")
	if err != nil {
		t.Fatalf("GetManagedModelGrant: %v", err)
	}
	if len(loaded.ModelPlanIDs) != 2 || loaded.ModelPlanIDs[0] != "plan-one" || loaded.ModelPlanIDs[1] != "plan-two" {
		t.Fatalf("loaded model plan ids = %#v", loaded.ModelPlanIDs)
	}
	grants, err := store.ListManagedModelGrants(ctx, "ws-grant")
	if err != nil {
		t.Fatalf("ListManagedModelGrants: %v", err)
	}
	if len(grants) != 1 || grants[0].GrantRef != "grant-one" || len(grants[0].ModelPlanIDs) != 2 {
		t.Fatalf("listed grants = %#v", grants)
	}
}
