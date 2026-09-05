package agentstatus

import (
	"context"
	"path/filepath"
	"reflect"
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

func TestCodexRuntimeCatalogSelectionMarksMissingExplicitRuntimeStale(t *testing.T) {
	selection := agentproviderbiz.RuntimeSelection{LauncherPath: "/missing/codex"}
	got := codexRuntimeCatalogSelection([]CodexRuntimeCatalogCandidate{{ID: "candidate", LauncherPath: "/bin/codex"}}, codexRuntimeResolvedSelection{Selection: selection, Explicit: true})
	if got.State != CodexRuntimeSelectionStale || got.CandidateID != "" {
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

func TestCodexRuntimeSelectionUsesOnlyReadyCandidateForStatusAndLaunch(t *testing.T) {
	home := t.TempDir()
	broken := filepath.Join(home, "broken", "codex")
	healthy := filepath.Join(home, "healthy", "codex")
	broken = writeCodexVersionFixture(t, broken, MinSupportedCodexVersion)
	healthy = writeCodexVersionFixture(t, healthy, MinSupportedCodexVersion)
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

func TestCodexRuntimeSelectionRequiresAUserChoiceBeforeStatusOrLaunch(t *testing.T) {
	home := t.TempDir()
	first := filepath.Join(home, "first", "codex")
	second := filepath.Join(home, "second", "codex")
	first = writeCodexVersionFixture(t, first, MinSupportedCodexVersion)
	second = writeCodexVersionFixture(t, second, MinSupportedCodexVersion)
	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + filepath.Dir(first) + string(filepath.ListSeparator) + filepath.Dir(second)}
	}
	service.CodexRuntimeSelectionStore = &memoryCodexRuntimeSelectionStore{}
	service.CodexProtocolProbe = func(_ context.Context, _ []string, _ []string) CodexProbeEvidence {
		return CodexProbeEvidence{CommandStarted: true, ProtocolReady: true}
	}

	if _, err := service.ResolveProviderCommand(context.Background(), agentproviderbiz.Codex); err == nil || err.Error() != "codex_runtime_selection_required" {
		t.Fatalf("ResolveProviderCommand() error = %v, want selection-required error", err)
	}
	specs, err := service.selectProviderSpecs(context.Background(), []string{agentproviderbiz.Codex}, true)
	if err != nil {
		t.Fatalf("selectProviderSpecs() error = %v", err)
	}
	runtime := service.resolveProviderRuntime(context.Background(), specs[0])
	if runtime.AdapterPath != "" || runtime.CLIPath != "" || runtime.ReasonCode != "codex_runtime_selection_required" || runtime.CodexSelectionState != CodexRuntimeSelectionSelectionRequired {
		t.Fatalf("status runtime = %#v; want a blocked selection", runtime)
	}
	status := service.statusForSpec(context.Background(), specs[0], service.now(), statusDetectionOptions{})
	if status.Availability.Status != AvailabilityUnknown || status.Availability.ReasonCode != "codex_runtime_selection_required" || len(status.Actions) != 0 {
		t.Fatalf("status = %#v; want selection-required status without install action", status)
	}
	service.InstallCommand = func(context.Context, InstallCommandInput) (InstallCommandResult, error) {
		t.Fatal("InstallCommand called while a Codex runtime choice is required")
		return InstallCommandResult{}, nil
	}
	install, err := service.RunAction(context.Background(), RunActionInput{Provider: agentproviderbiz.Codex, ActionID: ActionInstall})
	if err != nil {
		t.Fatalf("RunAction() error = %v", err)
	}
	if install.Status != RunActionFailed || install.ReasonCode != "codex_runtime_selection_required" || install.Command != "" {
		t.Fatalf("install = %#v; want blocked selection without installer mutation", install)
	}
}

func TestCodexRuntimeSelectionPersistsOnlyAReadyCandidateFromTheCurrentCatalog(t *testing.T) {
	home := t.TempDir()
	first := filepath.Join(home, "first", "codex")
	second := filepath.Join(home, "second", "codex")
	first = writeCodexVersionFixture(t, first, MinSupportedCodexVersion)
	second = writeCodexVersionFixture(t, second, MinSupportedCodexVersion)
	store := &memoryCodexRuntimeSelectionStore{}
	service := probeTestService(home)
	service.Environ = func() []string {
		return []string{"PATH=" + filepath.Dir(first) + string(filepath.ListSeparator) + filepath.Dir(second)}
	}
	service.CodexRuntimeSelectionStore = store
	service.CodexProtocolProbe = func(_ context.Context, _ []string, _ []string) CodexProbeEvidence {
		return CodexProbeEvidence{CommandStarted: true, ProtocolReady: true}
	}

	catalog, err := service.GetCodexRuntimeCatalog(context.Background(), agentproviderbiz.Codex)
	if err != nil {
		t.Fatalf("GetCodexRuntimeCatalog() error = %v", err)
	}
	if catalog.Selection.State != CodexRuntimeSelectionSelectionRequired || len(catalog.Candidates) != 2 {
		t.Fatalf("catalog = %#v; want two candidates and a required selection", catalog)
	}
	selected, err := service.SetCodexRuntimeSelection(context.Background(), SetCodexRuntimeSelectionInput{
		Provider:    agentproviderbiz.Codex,
		CandidateID: catalog.Candidates[1].ID,
		Revision:    catalog.Revision,
	})
	if err != nil {
		t.Fatalf("SetCodexRuntimeSelection() error = %v", err)
	}
	if selected.Selection.State != CodexRuntimeSelectionSelected || selected.Selection.CandidateID != catalog.Candidates[1].ID {
		t.Fatalf("selected catalog = %#v", selected)
	}
	if !store.found || store.selection.LauncherPath != second {
		t.Fatalf("persisted selection = %#v, want %q", store.selection, second)
	}
	command, err := service.ResolveProviderCommand(context.Background(), agentproviderbiz.Codex)
	if err != nil || len(command.Command) == 0 || command.Command[0] != second {
		t.Fatalf("ResolveProviderCommand() = %#v, %v; want selected launcher", command, err)
	}

	if _, err := service.SetCodexRuntimeSelection(context.Background(), SetCodexRuntimeSelectionInput{
		Provider:    agentproviderbiz.Codex,
		CandidateID: catalog.Candidates[0].ID,
		Revision:    "stale-revision",
	}); err != ErrRuntimeCatalogRevisionConflict {
		t.Fatalf("SetCodexRuntimeSelection() error = %v, want revision conflict", err)
	}
}

func TestCodexRuntimeSelectionDoesNotFallbackFromBrokenExplicitCandidate(t *testing.T) {
	home := t.TempDir()
	broken := filepath.Join(home, "broken", "codex")
	healthy := filepath.Join(home, "healthy", "codex")
	broken = writeCodexVersionFixture(t, broken, MinSupportedCodexVersion)
	healthy = writeCodexVersionFixture(t, healthy, MinSupportedCodexVersion)
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

	if _, err := service.ResolveProviderCommand(context.Background(), agentproviderbiz.Codex); err == nil || err.Error() != "codex_runtime_selection_stale" {
		t.Fatalf("ResolveProviderCommand() error = %v, want explicit candidate failure", err)
	}
	specs, err := service.selectProviderSpecs(context.Background(), []string{agentproviderbiz.Codex}, true)
	if err != nil {
		t.Fatalf("selectProviderSpecs() error = %v", err)
	}
	runtime := service.resolveProviderRuntime(context.Background(), specs[0])
	if runtime.AdapterPath != "" || runtime.CLIPath != broken || runtime.ReasonCode != "codex_runtime_selection_stale" || runtime.CodexSelectionState != CodexRuntimeSelectionStale {
		t.Fatalf("status runtime = %#v; must retain the explicit broken candidate without fallback", runtime)
	}
}

func TestSetCodexRuntimeSelectionInvalidatesDerivedAvailability(t *testing.T) {
	home := t.TempDir()
	launcher := filepath.Join(home, "codex")
	launcher = writeCodexVersionFixture(t, launcher, MinSupportedCodexVersion)
	service := probeTestService(home)
	service.CodexRuntimeSelectionStore = &memoryCodexRuntimeSelectionStore{}
	service.Environ = func() []string {
		return []string{"PATH=" + filepath.Dir(launcher)}
	}
	service.CodexProtocolProbe = func(_ context.Context, _, _ []string) CodexProbeEvidence {
		return CodexProbeEvidence{CommandStarted: true, ProtocolReady: true}
	}
	var invalidated []string
	service.OnProviderStatusInvalidated = func(provider string) {
		invalidated = append(invalidated, provider)
	}

	catalog, err := service.GetCodexRuntimeCatalog(context.Background(), agentproviderbiz.Codex)
	if err != nil {
		t.Fatalf("GetCodexRuntimeCatalog() error = %v", err)
	}
	if _, err := service.SetCodexRuntimeSelection(context.Background(), SetCodexRuntimeSelectionInput{
		Provider:    agentproviderbiz.Codex,
		CandidateID: catalog.Candidates[0].ID,
		Revision:    catalog.Revision,
	}); err != nil {
		t.Fatalf("SetCodexRuntimeSelection() error = %v", err)
	}
	if !reflect.DeepEqual(invalidated, []string{agentproviderbiz.Codex}) {
		t.Fatalf("invalidated providers = %#v, want codex", invalidated)
	}
}
