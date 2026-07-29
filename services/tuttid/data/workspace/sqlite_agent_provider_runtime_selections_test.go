package workspace

import (
	"context"
	"testing"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func TestSQLiteStoreAgentProviderRuntimeSelectionRoundTrip(t *testing.T) {
	t.Parallel()
	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if _, found, err := store.GetAgentProviderRuntimeSelection(ctx, agentproviderbiz.Codex); err != nil || found {
		t.Fatalf("GetAgentProviderRuntimeSelection() before put = found %v, err %v", found, err)
	}
	stored, err := store.PutAgentProviderRuntimeSelection(ctx, agentproviderbiz.RuntimeSelection{
		Provider:     " CODEX ",
		LauncherPath: " /opt/homebrew/bin/codex ",
	})
	if err != nil {
		t.Fatalf("PutAgentProviderRuntimeSelection() error = %v", err)
	}
	if stored.Provider != agentproviderbiz.Codex || stored.LauncherPath != "/opt/homebrew/bin/codex" || stored.UpdatedAt.IsZero() {
		t.Fatalf("stored selection = %#v", stored)
	}
	got, found, err := store.GetAgentProviderRuntimeSelection(ctx, agentproviderbiz.Codex)
	if err != nil || !found || got.LauncherPath != stored.LauncherPath {
		t.Fatalf("GetAgentProviderRuntimeSelection() = %#v, found %v, err %v", got, found, err)
	}
	if err := store.DeleteAgentProviderRuntimeSelection(ctx, agentproviderbiz.Codex); err != nil {
		t.Fatalf("DeleteAgentProviderRuntimeSelection() error = %v", err)
	}
	if _, found, err := store.GetAgentProviderRuntimeSelection(ctx, agentproviderbiz.Codex); err != nil || found {
		t.Fatalf("GetAgentProviderRuntimeSelection() after delete = found %v, err %v", found, err)
	}
}
