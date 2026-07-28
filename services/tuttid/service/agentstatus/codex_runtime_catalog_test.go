package agentstatus

import (
	"testing"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func TestCodexRuntimeCatalogSelectionMarksMissingExplicitRuntimeStale(t *testing.T) {
	selection := agentproviderbiz.RuntimeSelection{LauncherPath: "/missing/codex"}
	got := codexRuntimeCatalogSelection([]CodexRuntimeCatalogCandidate{{ID: "candidate", LauncherPath: "/bin/codex"}}, selection, true)
	if got.Mode != CodexRuntimeSelectionExplicit || got.State != CodexRuntimeSelectionStale || got.CandidateID != "" {
		t.Fatalf("selection = %#v", got)
	}
}

func TestCodexRuntimeCatalogRevisionDependsOnCandidateOrder(t *testing.T) {
	first := codexRuntimeCatalogRevision([]CodexRuntimeCatalogCandidate{{ID: "one"}, {ID: "two"}})
	second := codexRuntimeCatalogRevision([]CodexRuntimeCatalogCandidate{{ID: "two"}, {ID: "one"}})
	if first == second {
		t.Fatal("revisions must change when candidate order changes")
	}
}
