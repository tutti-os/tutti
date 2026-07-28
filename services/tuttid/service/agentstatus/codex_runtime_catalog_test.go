package agentstatus

import (
	"context"
	"path/filepath"
	"testing"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

type memoryCodexRuntimeSelectionStore struct {
	selection agentproviderbiz.RuntimeSelection
	found     bool
}

func (s *memoryCodexRuntimeSelectionStore) GetAgentProviderRuntimeSelection(_ context.Context, _ string) (agentproviderbiz.RuntimeSelection, bool, error) {
	return s.selection, s.found, nil
}

func (s *memoryCodexRuntimeSelectionStore) PutAgentProviderRuntimeSelection(_ context.Context, selection agentproviderbiz.RuntimeSelection) (agentproviderbiz.RuntimeSelection, error) {
	s.selection, s.found = selection, true
	return selection, nil
}

func (s *memoryCodexRuntimeSelectionStore) DeleteAgentProviderRuntimeSelection(_ context.Context, _ string) error {
	s.selection, s.found = agentproviderbiz.RuntimeSelection{}, false
	return nil
}

func TestCodexRuntimeCatalogSelectionMarksMissingExplicitRuntimeStale(t *testing.T) {
	selection := agentproviderbiz.RuntimeSelection{LauncherPath: "/missing/codex"}
	got := codexRuntimeCatalogSelection([]CodexRuntimeCatalogCandidate{{ID: "candidate", LauncherPath: "/bin/codex"}}, codexRuntimeResolvedSelection{Selection: selection, Explicit: true})
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

func TestCodexRuntimeSelectionUsesHealthyLaterCandidateForStatusAndLaunch(t *testing.T) {
	home := t.TempDir()
	broken := filepath.Join(home, "broken", "codex")
	healthy := filepath.Join(home, "healthy", "codex")
	writeCodexVersionFixture(t, broken, "0.142.0")
	writeCodexVersionFixture(t, healthy, "0.142.0")
	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + filepath.Dir(broken) + string(filepath.ListSeparator) + filepath.Dir(healthy)}
	}
	service.CodexRuntimeSelectionStore = &memoryCodexRuntimeSelectionStore{}
	service.CodexProtocolProbe = func(_ context.Context, command, _ []string) CodexProbeEvidence {
		if command[0] == broken {
			return CodexProbeEvidence{CommandStarted: true, Category: "app_server_unsupported"}
		}
		return CodexProbeEvidence{CommandStarted: true, ProtocolReady: true}
	}

	command, err := service.ResolveProviderCommand(context.Background(), agentproviderbiz.Codex)
	if err != nil || command.Command[0] != healthy {
		t.Fatalf("ResolveProviderCommand() = %#v, %v; want healthy launcher", command, err)
	}
	specs, err := service.selectProviderSpecs(context.Background(), []string{agentproviderbiz.Codex}, true)
	if err != nil {
		t.Fatalf("selectProviderSpecs() error = %v", err)
	}
	runtime := service.resolveProviderRuntime(context.Background(), specs[0])
	if runtime.AdapterPath != healthy || runtime.AdapterCommand[0] != healthy {
		t.Fatalf("status runtime = %#v; want healthy launcher", runtime)
	}
}

func TestCodexRuntimeSelectionDoesNotFallbackFromBrokenExplicitCandidate(t *testing.T) {
	home := t.TempDir()
	broken := filepath.Join(home, "broken", "codex")
	healthy := filepath.Join(home, "healthy", "codex")
	writeCodexVersionFixture(t, broken, "0.142.0")
	writeCodexVersionFixture(t, healthy, "0.142.0")
	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + filepath.Dir(broken) + string(filepath.ListSeparator) + filepath.Dir(healthy)}
	}
	service.CodexRuntimeSelectionStore = &memoryCodexRuntimeSelectionStore{selection: agentproviderbiz.RuntimeSelection{Provider: agentproviderbiz.Codex, LauncherPath: broken}, found: true}
	service.CodexProtocolProbe = func(_ context.Context, command, _ []string) CodexProbeEvidence {
		if command[0] == broken {
			return CodexProbeEvidence{CommandStarted: true, Category: "app_server_unsupported"}
		}
		return CodexProbeEvidence{CommandStarted: true, ProtocolReady: true}
	}

	if _, err := service.ResolveProviderCommand(context.Background(), agentproviderbiz.Codex); err == nil || err.Error() != "app_server_unsupported" {
		t.Fatalf("ResolveProviderCommand() error = %v, want explicit candidate failure", err)
	}
	specs, err := service.selectProviderSpecs(context.Background(), []string{agentproviderbiz.Codex}, true)
	if err != nil {
		t.Fatalf("selectProviderSpecs() error = %v", err)
	}
	runtime := service.resolveProviderRuntime(context.Background(), specs[0])
	if runtime.AdapterPath != "" || runtime.CLIPath != broken || runtime.ReasonCode != "app_server_unsupported" {
		t.Fatalf("status runtime = %#v; must retain the explicit broken candidate without fallback", runtime)
	}
}
