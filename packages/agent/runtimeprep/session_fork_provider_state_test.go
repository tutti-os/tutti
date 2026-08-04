package runtimeprep

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDefaultPreparerDeclaresForkProviderStateBindingPerProvider(t *testing.T) {
	preparer := NewDefaultPreparer(t.TempDir())
	if !preparer.SupportsSessionForkProviderStateBinding("codex") {
		t.Fatal("Codex provider state binding = false, want true")
	}
	if !preparer.SupportsSessionForkProviderStateBinding("tutti-agent") {
		t.Fatal("Tutti Agent provider state binding = false, want true")
	}
	if preparer.SupportsSessionForkProviderStateBinding("claude-code") {
		t.Fatal("Claude provider state binding = true before explicit integration")
	}
}

func TestDefaultPreparerBindsExactTuttiAgentForkRolloutToIndependentTargetRuntime(
	t *testing.T,
) {
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	targetRoot, err := store.RuntimeRoot("workspace-1", "target-session")
	if err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(
		sourceRoot,
		tuttiAgentHomeDirectory,
		"sessions",
		"2026",
		"07",
		"30",
		"rollout-2026-07-30T11-38-33-target-thread.jsonl",
	)
	writeTestCodexRollout(t, sourcePath, "target-thread")

	if err := preparer.BindSessionForkProviderState(
		t.Context(),
		SessionForkProviderStateBindingInput{
			WorkspaceID:             "workspace-1",
			Provider:                "tutti-agent",
			SourceAgentSessionID:    "source-session",
			TargetAgentSessionID:    "target-session",
			SourceProviderSessionID: "source-thread",
			TargetProviderSessionID: "target-thread",
		},
	); err != nil {
		t.Fatalf("BindSessionForkProviderState() error = %v", err)
	}

	targetPath := filepath.Join(
		targetRoot,
		tuttiAgentHomeDirectory,
		"sessions",
		"2026",
		"07",
		"30",
		filepath.Base(sourcePath),
	)
	if targetInfo, err := os.Lstat(targetPath); err != nil {
		t.Fatalf("target rollout stat: %v", err)
	} else if !targetInfo.Mode().IsRegular() ||
		targetInfo.Mode()&os.ModeSymlink != 0 {
		t.Fatalf(
			"target rollout mode = %v, want independent regular file",
			targetInfo.Mode(),
		)
	}
	if _, err := os.Stat(filepath.Join(
		targetRoot,
		codexHomeDirectory,
	)); !os.IsNotExist(err) {
		t.Fatalf("Tutti Agent rollout leaked into Codex home: %v", err)
	}
}

func TestDefaultPreparerBindsExactCodexForkRolloutToIndependentTargetRuntime(t *testing.T) {
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	targetRoot, err := store.RuntimeRoot("workspace-1", "target-session")
	if err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(
		sourceRoot,
		codexHomeDirectory,
		"sessions",
		"2026",
		"07",
		"28",
		"rollout-2026-07-28T11-38-33-target-thread.jsonl",
	)
	writeTestCodexRollout(t, sourcePath, "target-thread")
	unrelatedPath := filepath.Join(
		sourceRoot,
		codexHomeDirectory,
		"sessions",
		"2026",
		"07",
		"28",
		"rollout-2026-07-28T11-30-00-unrelated-thread.jsonl",
	)
	writeTestCodexRollout(t, unrelatedPath, "unrelated-thread")

	input := SessionForkProviderStateBindingInput{
		WorkspaceID:             "workspace-1",
		Provider:                "codex",
		SourceAgentSessionID:    "source-session",
		TargetAgentSessionID:    "target-session",
		SourceProviderSessionID: "source-thread",
		TargetProviderSessionID: "target-thread",
	}
	if err := preparer.BindSessionForkProviderState(context.Background(), input); err != nil {
		t.Fatalf("BindSessionForkProviderState() error = %v", err)
	}
	targetPath := filepath.Join(
		targetRoot,
		codexHomeDirectory,
		"sessions",
		"2026",
		"07",
		"28",
		filepath.Base(sourcePath),
	)
	targetInfo, err := os.Lstat(targetPath)
	if err != nil {
		t.Fatalf("target rollout stat: %v", err)
	}
	if !targetInfo.Mode().IsRegular() || targetInfo.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("target rollout mode = %v, want independent regular file", targetInfo.Mode())
	}
	if _, err := os.Stat(filepath.Join(
		targetRoot,
		codexHomeDirectory,
		"sessions",
		"2026",
		"07",
		"28",
		filepath.Base(unrelatedPath),
	)); !os.IsNotExist(err) {
		t.Fatalf("unrelated rollout was copied, stat error = %v", err)
	}

	if err := os.Remove(sourcePath); err != nil {
		t.Fatal(err)
	}
	if matches, err := codexRolloutMatches(targetPath, "target-thread"); err != nil || !matches {
		t.Fatalf("target rollout after source removal: matches=%v error=%v", matches, err)
	}
	if err := preparer.BindSessionForkProviderState(context.Background(), input); err != nil {
		t.Fatalf("idempotent BindSessionForkProviderState() error = %v", err)
	}
}

func TestDefaultPreparerRejectsCodexRolloutWhoseMetadataDoesNotMatchTarget(t *testing.T) {
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(
		sourceRoot,
		codexHomeDirectory,
		"sessions",
		"2026",
		"07",
		"28",
		"rollout-2026-07-28T11-38-33-target-thread.jsonl",
	)
	writeTestCodexRollout(t, sourcePath, "different-thread")

	err = preparer.BindSessionForkProviderState(
		context.Background(),
		SessionForkProviderStateBindingInput{
			WorkspaceID:             "workspace-1",
			Provider:                "codex",
			SourceAgentSessionID:    "source-session",
			TargetAgentSessionID:    "target-session",
			SourceProviderSessionID: "source-thread",
			TargetProviderSessionID: "target-thread",
		},
	)
	if err == nil || !strings.Contains(err.Error(), "was not found") {
		t.Fatalf("BindSessionForkProviderState() error = %v, want identity mismatch rejection", err)
	}
}

func TestDefaultPreparerRepairsTargetCodexRolloutWithCorruptTail(t *testing.T) {
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	targetRoot, err := store.RuntimeRoot("workspace-1", "target-session")
	if err != nil {
		t.Fatal(err)
	}
	relativePath := filepath.Join(
		"sessions",
		"2026",
		"07",
		"28",
		"rollout-2026-07-28T11-38-33-target-thread.jsonl",
	)
	sourcePath := filepath.Join(sourceRoot, codexHomeDirectory, relativePath)
	targetPath := filepath.Join(targetRoot, codexHomeDirectory, relativePath)
	writeTestCodexRollout(t, sourcePath, "target-thread")
	writeTestCorruptCodexRollout(t, targetPath, "target-thread")

	if err := preparer.BindSessionForkProviderState(
		context.Background(),
		SessionForkProviderStateBindingInput{
			WorkspaceID:             "workspace-1",
			Provider:                "codex",
			SourceAgentSessionID:    "source-session",
			TargetAgentSessionID:    "target-session",
			SourceProviderSessionID: "source-thread",
			TargetProviderSessionID: "target-thread",
		},
	); err != nil {
		t.Fatalf("BindSessionForkProviderState() repair error = %v", err)
	}
	if matches, err := codexRolloutMatches(targetPath, "target-thread"); err != nil || !matches {
		t.Fatalf("repaired target rollout: matches=%v error=%v", matches, err)
	}
	sourceBytes, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	targetBytes, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(targetBytes) != string(sourceBytes) {
		t.Fatal("repaired target rollout does not exactly match source")
	}
}

func TestDefaultPreparerRepairsCorruptArchivedTargetCodexRolloutInPlace(t *testing.T) {
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	targetRoot, err := store.RuntimeRoot("workspace-1", "target-session")
	if err != nil {
		t.Fatal(err)
	}
	filename := "rollout-2026-07-28T11-38-33-target-thread.jsonl"
	sourcePath := filepath.Join(
		sourceRoot,
		codexHomeDirectory,
		"sessions",
		"2026",
		"07",
		"28",
		filename,
	)
	archivedTargetPath := filepath.Join(
		targetRoot,
		codexHomeDirectory,
		"archived_sessions",
		filename,
	)
	writeTestCodexRollout(t, sourcePath, "target-thread")
	writeTestCorruptCodexRollout(t, archivedTargetPath, "target-thread")

	if err := preparer.BindSessionForkProviderState(
		context.Background(),
		SessionForkProviderStateBindingInput{
			WorkspaceID:             "workspace-1",
			Provider:                "codex",
			SourceAgentSessionID:    "source-session",
			TargetAgentSessionID:    "target-session",
			SourceProviderSessionID: "source-thread",
			TargetProviderSessionID: "target-thread",
		},
	); err != nil {
		t.Fatalf("BindSessionForkProviderState() repair error = %v", err)
	}
	sourceBytes, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	archivedBytes, err := os.ReadFile(archivedTargetPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(archivedBytes) != string(sourceBytes) {
		t.Fatal("archived target rollout was not repaired in place")
	}
	sessionsTargetPath := filepath.Join(
		targetRoot,
		codexHomeDirectory,
		"sessions",
		"2026",
		"07",
		"28",
		filename,
	)
	if _, err := os.Stat(sessionsTargetPath); !os.IsNotExist(err) {
		t.Fatalf("second target rollout was created at source-relative path, stat error = %v", err)
	}
}

func TestDefaultPreparerRejectsDamagedTargetCodexRolloutWithoutVerifiableIdentity(t *testing.T) {
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	targetRoot, err := store.RuntimeRoot("workspace-1", "target-session")
	if err != nil {
		t.Fatal(err)
	}
	filename := "rollout-2026-07-28T11-38-33-target-thread.jsonl"
	sourcePath := filepath.Join(
		sourceRoot,
		codexHomeDirectory,
		"sessions",
		"2026",
		"07",
		"28",
		filename,
	)
	damagedTargetPath := filepath.Join(
		targetRoot,
		codexHomeDirectory,
		"archived_sessions",
		filename,
	)
	writeTestCodexRollout(t, sourcePath, "target-thread")
	if err := os.MkdirAll(filepath.Dir(damagedTargetPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		damagedTargetPath,
		[]byte(`{"type":"session_meta","payload":`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	err = preparer.BindSessionForkProviderState(
		context.Background(),
		SessionForkProviderStateBindingInput{
			WorkspaceID:             "workspace-1",
			Provider:                "codex",
			SourceAgentSessionID:    "source-session",
			TargetAgentSessionID:    "target-session",
			SourceProviderSessionID: "source-thread",
			TargetProviderSessionID: "target-thread",
		},
	)
	if err == nil || !strings.Contains(err.Error(), "cannot verify target provider session identity") {
		t.Fatalf("BindSessionForkProviderState() error = %v, want unverifiable target rejection", err)
	}
	sessionsTargetPath := filepath.Join(
		targetRoot,
		codexHomeDirectory,
		"sessions",
		"2026",
		"07",
		"28",
		filename,
	)
	if _, err := os.Stat(sessionsTargetPath); !os.IsNotExist(err) {
		t.Fatalf("replacement rollout was created despite unverifiable target, stat error = %v", err)
	}
}

func TestDefaultPreparerRepairsTargetCodexRolloutTruncatedAtRecordBoundary(t *testing.T) {
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	targetRoot, err := store.RuntimeRoot("workspace-1", "target-session")
	if err != nil {
		t.Fatal(err)
	}
	relativePath := filepath.Join(
		"sessions",
		"2026",
		"07",
		"28",
		"rollout-2026-07-28T11-38-33-target-thread.jsonl",
	)
	sourcePath := filepath.Join(sourceRoot, codexHomeDirectory, relativePath)
	targetPath := filepath.Join(targetRoot, codexHomeDirectory, relativePath)
	writeTestCodexRollout(t, sourcePath, "target-thread")
	sourceBytes, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	firstRecordEnd := strings.IndexByte(string(sourceBytes), '\n')
	if firstRecordEnd < 0 {
		t.Fatal("test rollout has no complete first record")
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetPath, sourceBytes[:firstRecordEnd+1], 0o600); err != nil {
		t.Fatal(err)
	}

	if err := preparer.BindSessionForkProviderState(
		context.Background(),
		SessionForkProviderStateBindingInput{
			WorkspaceID:             "workspace-1",
			Provider:                "codex",
			SourceAgentSessionID:    "source-session",
			TargetAgentSessionID:    "target-session",
			SourceProviderSessionID: "source-thread",
			TargetProviderSessionID: "target-thread",
		},
	); err != nil {
		t.Fatalf("BindSessionForkProviderState() repair error = %v", err)
	}
	targetBytes, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(targetBytes) != string(sourceBytes) {
		t.Fatal("record-boundary-truncated target rollout was not repaired from source")
	}
}

func TestDefaultPreparerPreservesValidCodexRolloutAppendedAfterFork(t *testing.T) {
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	targetRoot, err := store.RuntimeRoot("workspace-1", "target-session")
	if err != nil {
		t.Fatal(err)
	}
	relativePath := filepath.Join(
		"sessions",
		"2026",
		"07",
		"28",
		"rollout-2026-07-28T11-38-33-target-thread.jsonl",
	)
	sourcePath := filepath.Join(sourceRoot, codexHomeDirectory, relativePath)
	targetPath := filepath.Join(targetRoot, codexHomeDirectory, relativePath)
	writeTestCodexRollout(t, sourcePath, "target-thread")
	input := SessionForkProviderStateBindingInput{
		WorkspaceID:             "workspace-1",
		Provider:                "codex",
		SourceAgentSessionID:    "source-session",
		TargetAgentSessionID:    "target-session",
		SourceProviderSessionID: "source-thread",
		TargetProviderSessionID: "target-thread",
	}
	if err := preparer.BindSessionForkProviderState(context.Background(), input); err != nil {
		t.Fatalf("initial BindSessionForkProviderState() error = %v", err)
	}
	target, err := os.OpenFile(targetPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range []string{
		`{"type":"event_msg","payload":{"type":"task_started","turn_id":"post-fork-turn-1"}}`,
		`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"post-fork-turn-1"}}`,
		`{"type":"event_msg","payload":{"type":"task_started","turn_id":"post-fork-turn-2"}}`,
		`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"post-fork-turn-2"}}`,
	} {
		if _, err := target.WriteString(record + "\n"); err != nil {
			_ = target.Close()
			t.Fatal(err)
		}
	}
	if err := target.Close(); err != nil {
		t.Fatal(err)
	}
	appendedBytes, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatal(err)
	}

	if err := preparer.BindSessionForkProviderState(context.Background(), input); err != nil {
		t.Fatalf("repeat BindSessionForkProviderState() error = %v", err)
	}
	afterRepeatBytes, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(afterRepeatBytes) != string(appendedBytes) {
		t.Fatal("repeat binding replaced valid post-fork appended history")
	}
	if !strings.Contains(string(afterRepeatBytes), "post-fork-turn-1") ||
		!strings.Contains(string(afterRepeatBytes), "post-fork-turn-2") {
		t.Fatal("repeat binding lost post-fork Turn history needed by nested Fork")
	}
}

func TestDefaultPreparerDoesNotOverwritePostForkHistoryWithCorruptTail(t *testing.T) {
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	targetRoot, err := store.RuntimeRoot("workspace-1", "target-session")
	if err != nil {
		t.Fatal(err)
	}
	relativePath := filepath.Join(
		"sessions",
		"2026",
		"07",
		"28",
		"rollout-2026-07-28T11-38-33-target-thread.jsonl",
	)
	sourcePath := filepath.Join(sourceRoot, codexHomeDirectory, relativePath)
	targetPath := filepath.Join(targetRoot, codexHomeDirectory, relativePath)
	writeTestCodexRollout(t, sourcePath, "target-thread")
	input := SessionForkProviderStateBindingInput{
		WorkspaceID:             "workspace-1",
		Provider:                "codex",
		SourceAgentSessionID:    "source-session",
		TargetAgentSessionID:    "target-session",
		SourceProviderSessionID: "source-thread",
		TargetProviderSessionID: "target-thread",
	}
	if err := preparer.BindSessionForkProviderState(context.Background(), input); err != nil {
		t.Fatalf("initial BindSessionForkProviderState() error = %v", err)
	}
	target, err := os.OpenFile(targetPath, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := target.WriteString(
		`{"type":"event_msg","payload":{"type":"task_complete","message":"preserve me"}}` + "\n" +
			`{"type":`,
	); err != nil {
		_ = target.Close()
		t.Fatal(err)
	}
	if err := target.Close(); err != nil {
		t.Fatal(err)
	}
	beforeBinding, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatal(err)
	}

	err = preparer.BindSessionForkProviderState(context.Background(), input)
	if err == nil || !strings.Contains(err.Error(), "diverges") {
		t.Fatalf("repeat BindSessionForkProviderState() error = %v, want fail-closed divergence", err)
	}
	afterBinding, readErr := os.ReadFile(targetPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(afterBinding) != string(beforeBinding) {
		t.Fatal("damaged target rollout with complete post-fork history was overwritten")
	}
}

func TestDefaultPreparerRejectsDivergentValidCodexRollout(t *testing.T) {
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	targetRoot, err := store.RuntimeRoot("workspace-1", "target-session")
	if err != nil {
		t.Fatal(err)
	}
	relativePath := filepath.Join(
		"sessions",
		"2026",
		"07",
		"28",
		"rollout-2026-07-28T11-38-33-target-thread.jsonl",
	)
	sourcePath := filepath.Join(sourceRoot, codexHomeDirectory, relativePath)
	targetPath := filepath.Join(targetRoot, codexHomeDirectory, relativePath)
	writeTestCodexRollout(t, sourcePath, "target-thread")
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		t.Fatal(err)
	}
	divergent := `{"type":"session_meta","payload":{"id":"target-thread"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"different_history"}}` + "\n"
	if err := os.WriteFile(targetPath, []byte(divergent), 0o600); err != nil {
		t.Fatal(err)
	}

	err = preparer.BindSessionForkProviderState(
		context.Background(),
		SessionForkProviderStateBindingInput{
			WorkspaceID:             "workspace-1",
			Provider:                "codex",
			SourceAgentSessionID:    "source-session",
			TargetAgentSessionID:    "target-session",
			SourceProviderSessionID: "source-thread",
			TargetProviderSessionID: "target-thread",
		},
	)
	if err == nil || !strings.Contains(err.Error(), "diverges") {
		t.Fatalf("BindSessionForkProviderState() error = %v, want divergence rejection", err)
	}
	targetBytes, readErr := os.ReadFile(targetPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(targetBytes) != divergent {
		t.Fatal("divergent target rollout was overwritten")
	}
}

func TestDefaultPreparerRejectsSourceCodexRolloutWithCorruptTail(t *testing.T) {
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(
		sourceRoot,
		codexHomeDirectory,
		"sessions",
		"2026",
		"07",
		"28",
		"rollout-2026-07-28T11-38-33-target-thread.jsonl",
	)
	writeTestCorruptCodexRollout(t, sourcePath, "target-thread")

	err = preparer.BindSessionForkProviderState(
		context.Background(),
		SessionForkProviderStateBindingInput{
			WorkspaceID:             "workspace-1",
			Provider:                "codex",
			SourceAgentSessionID:    "source-session",
			TargetAgentSessionID:    "target-session",
			SourceProviderSessionID: "source-thread",
			TargetProviderSessionID: "target-thread",
		},
	)
	if err == nil || !strings.Contains(err.Error(), "codex rollout record 2") {
		t.Fatalf("BindSessionForkProviderState() error = %v, want corrupt-tail rejection", err)
	}
}

func TestDefaultPreparerRejectsSymlinkInTargetCodexStatePath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires Windows symlink privilege")
	}
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	targetRoot, err := store.RuntimeRoot("workspace-1", "target-session")
	if err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(
		sourceRoot,
		codexHomeDirectory,
		"sessions",
		"2026",
		"07",
		"28",
		"rollout-2026-07-28T11-38-33-target-thread.jsonl",
	)
	writeTestCodexRollout(t, sourcePath, "target-thread")
	if err := os.MkdirAll(filepath.Join(targetRoot, codexHomeDirectory), 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(
		outside,
		filepath.Join(targetRoot, codexHomeDirectory, "sessions"),
	); err != nil {
		t.Fatal(err)
	}

	err = preparer.BindSessionForkProviderState(
		context.Background(),
		SessionForkProviderStateBindingInput{
			WorkspaceID:             "workspace-1",
			Provider:                "codex",
			SourceAgentSessionID:    "source-session",
			TargetAgentSessionID:    "target-session",
			SourceProviderSessionID: "source-thread",
			TargetProviderSessionID: "target-thread",
		},
	)
	if err == nil || !strings.Contains(err.Error(), "not a regular directory") {
		t.Fatalf("BindSessionForkProviderState() error = %v, want symlink rejection", err)
	}
	if entries, readErr := os.ReadDir(outside); readErr != nil || len(entries) != 0 {
		t.Fatalf("outside target entries=%v error=%v", entries, readErr)
	}
}

func TestDefaultPreparerRejectsTargetAncestorSymlinkWithExistingMatchingRollout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires Windows symlink privilege")
	}
	for _, test := range []struct {
		name          string
		linkTargetDir func(targetRoot, outside string) string
		outsideHome   func(outside string) string
	}{
		{
			name: "runtime root",
			linkTargetDir: func(targetRoot, _ string) string {
				return targetRoot
			},
			outsideHome: func(outside string) string {
				return filepath.Join(outside, codexHomeDirectory)
			},
		},
		{
			name: "codex home",
			linkTargetDir: func(targetRoot, _ string) string {
				return filepath.Join(targetRoot, codexHomeDirectory)
			},
			outsideHome: func(outside string) string {
				return outside
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			stateDir := t.TempDir()
			preparer := NewDefaultPreparer(stateDir)
			store := LocalStore{StateDir: stateDir}
			sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
			if err != nil {
				t.Fatal(err)
			}
			targetRoot, err := store.RuntimeRoot("workspace-1", "target-session")
			if err != nil {
				t.Fatal(err)
			}
			sourcePath := filepath.Join(
				sourceRoot,
				codexHomeDirectory,
				"sessions",
				"2026",
				"07",
				"28",
				"rollout-2026-07-28T11-38-33-target-thread.jsonl",
			)
			writeTestCodexRollout(t, sourcePath, "target-thread")
			outside := t.TempDir()
			outsideRollout := filepath.Join(
				test.outsideHome(outside),
				"sessions",
				"2026",
				"07",
				"28",
				filepath.Base(sourcePath),
			)
			writeTestCodexRollout(t, outsideRollout, "target-thread")
			linkPath := test.linkTargetDir(targetRoot, outside)
			if err := os.MkdirAll(filepath.Dir(linkPath), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, linkPath); err != nil {
				t.Fatal(err)
			}

			err = preparer.BindSessionForkProviderState(
				context.Background(),
				SessionForkProviderStateBindingInput{
					WorkspaceID:             "workspace-1",
					Provider:                "codex",
					SourceAgentSessionID:    "source-session",
					TargetAgentSessionID:    "target-session",
					SourceProviderSessionID: "source-thread",
					TargetProviderSessionID: "target-thread",
				},
			)
			if err == nil || !strings.Contains(err.Error(), "not a regular directory") {
				t.Fatalf("BindSessionForkProviderState() error = %v, want ancestor symlink rejection", err)
			}
		})
	}
}

func TestDefaultPreparerRejectsSourceCodexHomeSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires Windows symlink privilege")
	}
	stateDir := t.TempDir()
	preparer := NewDefaultPreparer(stateDir)
	store := LocalStore{StateDir: stateDir}
	sourceRoot, err := store.RuntimeRoot("workspace-1", "source-session")
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	outsideRollout := filepath.Join(
		outside,
		"sessions",
		"2026",
		"07",
		"28",
		"rollout-2026-07-28T11-38-33-target-thread.jsonl",
	)
	writeTestCodexRollout(t, outsideRollout, "target-thread")
	if err := os.MkdirAll(sourceRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(
		outside,
		filepath.Join(sourceRoot, codexHomeDirectory),
	); err != nil {
		t.Fatal(err)
	}

	err = preparer.BindSessionForkProviderState(
		context.Background(),
		SessionForkProviderStateBindingInput{
			WorkspaceID:             "workspace-1",
			Provider:                "codex",
			SourceAgentSessionID:    "source-session",
			TargetAgentSessionID:    "target-session",
			SourceProviderSessionID: "source-thread",
			TargetProviderSessionID: "target-thread",
		},
	)
	if err == nil || !strings.Contains(err.Error(), "not a regular directory") {
		t.Fatalf("BindSessionForkProviderState() error = %v, want source symlink rejection", err)
	}
}

func writeTestCodexRollout(t *testing.T, path, providerSessionID string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	content := `{"timestamp":"2026-07-28T03:38:33.521Z","type":"session_meta","payload":{"session_id":"` +
		providerSessionID + `","id":"` + providerSessionID + `"}}` + "\n" +
		`{"type":"event_msg","payload":{"type":"task_started"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeTestCorruptCodexRollout(t *testing.T, path, providerSessionID string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	content := `{"timestamp":"2026-07-28T03:38:33.521Z","type":"session_meta","payload":{"session_id":"` +
		providerSessionID + `","id":"` + providerSessionID + `"}}` + "\n" +
		`{"type":"event_msg","payload":`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
