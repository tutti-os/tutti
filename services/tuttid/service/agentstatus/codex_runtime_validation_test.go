package agentstatus

import (
	"context"
	"path/filepath"
	"runtime"
	"testing"
)

func TestValidateCodexRuntimeCandidatesImplicitlyUsesOnlyReadyCandidate(t *testing.T) {
	home := t.TempDir()
	broken := filepath.Join(home, "broken", "codex")
	healthy := filepath.Join(home, "healthy", "codex")
	broken = writeCodexVersionFixture(t, broken, MinSupportedCodexVersion)
	healthy = writeCodexVersionFixture(t, healthy, MinSupportedCodexVersion)

	service := probeTestService(home)
	service.CodexProtocolProbe = func(_ context.Context, command, _ []string) CodexProbeEvidence {
		if command[0] == broken {
			return CodexProbeEvidence{CommandStarted: true, Category: "app_server_unsupported"}
		}
		return CodexProbeEvidence{CommandStarted: true, ProtocolReady: true}
	}
	validations := service.validateCodexRuntimeCandidates(context.Background(), ProviderSpec{
		Provider:   "codex",
		MinVersion: MinSupportedCodexVersion,
	}, []codexRuntimeCandidate{{LauncherPath: broken}, {LauncherPath: healthy}})

	if got := validations[0].State; got != codexRuntimeCandidateValidationFailed {
		t.Fatalf("broken candidate state = %q, want failed", got)
	}
	if got := validations[1].State; got != codexRuntimeCandidateValidationReady {
		t.Fatalf("healthy candidate state = %q, want ready", got)
	}
	selection := decideCodexRuntimeImplicitSelection(validations)
	if selection.CandidateIndex != 1 || !selection.Launchable || selection.State != CodexRuntimeSelectionImplicitUnique {
		t.Fatalf("selection = %#v, want healthy second candidate", selection)
	}
}

func TestValidateCodexRuntimeCandidatesSkipsUnsupportedCandidate(t *testing.T) {
	home := t.TempDir()
	old := filepath.Join(home, "old", "codex")
	current := filepath.Join(home, "current", "codex")
	old = writeCodexVersionFixture(t, old, "0.125.0")
	current = writeCodexVersionFixture(t, current, MinSupportedCodexVersion)

	service := probeTestService(home)
	service.CodexProtocolProbe = codexProtocolReadyFixture
	validations := service.validateCodexRuntimeCandidates(context.Background(), ProviderSpec{
		Provider:   "codex",
		MinVersion: MinSupportedCodexVersion,
	}, []codexRuntimeCandidate{{LauncherPath: old}, {LauncherPath: current}})

	if got := validations[0].State; got != codexRuntimeCandidateValidationUnsupported {
		t.Fatalf("old candidate state = %q, want unsupported", got)
	}
	if got := validations[1].State; got != codexRuntimeCandidateValidationReady {
		t.Fatalf("current candidate state = %q, want ready", got)
	}
	if selection := decideCodexRuntimeImplicitSelection(validations); selection.CandidateIndex != 1 || !selection.Launchable || selection.State != CodexRuntimeSelectionImplicitUnique {
		t.Fatalf("selection = %#v, want current candidate", selection)
	}
}

func TestDecideCodexRuntimeImplicitSelectionRetainsFirstCandidateForDiagnosticsWhenNoneReady(t *testing.T) {
	selection := decideCodexRuntimeImplicitSelection([]codexRuntimeCandidateValidation{
		{State: codexRuntimeCandidateValidationFailed},
		{State: codexRuntimeCandidateValidationUnsupported},
	})
	if selection.CandidateIndex != 0 || selection.Launchable || selection.ReasonCode != "no_ready_candidate" || selection.State != CodexRuntimeSelectionUnavailable {
		t.Fatalf("selection = %#v, want first diagnostic candidate without launch permission", selection)
	}
}

func TestDecideCodexRuntimeImplicitSelectionRequiresAUserChoiceForMultipleReadyCandidates(t *testing.T) {
	selection := decideCodexRuntimeImplicitSelection([]codexRuntimeCandidateValidation{
		{State: codexRuntimeCandidateValidationReady},
		{State: codexRuntimeCandidateValidationReady},
		{State: codexRuntimeCandidateValidationFailed},
	})
	if selection.CandidateIndex != -1 || selection.Launchable || selection.ReasonCode != "codex_runtime_selection_required" || selection.State != CodexRuntimeSelectionSelectionRequired {
		t.Fatalf("selection = %#v, want a blocked multi-runtime selection", selection)
	}
}

func writeCodexVersionFixture(t *testing.T, path string, version string) string {
	t.Helper()
	contents := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex " + version + "'; exit 0; fi\nexit 0\n"
	if runtime.GOOS == "windows" {
		path += ".cmd"
		contents = "@echo off\r\nif \"%~1\"==\"--version\" (\r\n  echo codex " + version + "\r\n  exit /b 0\r\n)\r\nexit /b 0\r\n"
	}
	writeExecutable(t, path, contents)
	return path
}
