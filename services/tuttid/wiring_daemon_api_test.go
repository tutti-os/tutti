package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
)

func TestRegisterDaemonCodexPreparerCreatesPersonalSkillRootForFreshUser(t *testing.T) {
	userHome := t.TempDir()
	personalSkillRoot := filepath.Join(userHome, ".codex", "skills")
	if _, err := os.Lstat(personalSkillRoot); !os.IsNotExist(err) {
		t.Fatalf("personal Skill root exists before Host wiring: %v", err)
	}

	preparer := runtimeprep.NewDefaultPreparer(t.TempDir())
	preparer.CLICommand = "tutti"
	preparer.CommandCatalog = runtimePrepCommandCatalog{}
	if err := registerDaemonCodexPreparer(preparer, t.TempDir(), userHome); err != nil {
		t.Fatalf("registerDaemonCodexPreparer() error = %v", err)
	}
	info, err := os.Stat(personalSkillRoot)
	if err != nil {
		t.Fatalf("stat Host-created personal Skill root: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("Host-created personal Skill root mode = %v, want directory", info.Mode())
	}

	_, err = preparer.Prepare(context.Background(), runtimeprep.PrepareInput{
		WorkspaceID:       "workspace-1",
		AgentSessionID:    "session-1",
		AgentTargetID:     "local:codex",
		Provider:          "codex",
		Cwd:               t.TempDir(),
		ProviderStateHome: filepath.Join(userHome, ".codex"),
	})
	if err != nil {
		t.Fatalf("Prepare() error = %v", err)
	}
}
