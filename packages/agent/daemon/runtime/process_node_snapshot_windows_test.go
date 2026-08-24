//go:build windows

package agentruntime

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestVerifiedNodeScriptRunnerExecutesLockedSnapshot(t *testing.T) {
	nodePath, err := exec.LookPath("node.exe")
	if err != nil {
		t.Skip("node.exe is unavailable")
	}
	nodePath, err = filepath.EvalSymlinks(nodePath)
	if err != nil {
		t.Fatal(err)
	}
	scriptPath := filepath.Join(t.TempDir(), "probe.cjs")
	if err := os.WriteFile(scriptPath, []byte("process.stdout.write('locked-ok')\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := NewVerifiedNodeScriptRunner(t.TempDir())
	defer func() { _ = runner.Close() }()
	output, err := runner.Run(
		context.Background(), nodePath, scriptPath, nil, nil, fileIdentity(t, nodePath), fileIdentity(t, scriptPath), 32,
	)
	if err != nil || string(output) != "locked-ok" {
		t.Fatalf("locked Node snapshot output = %q, error = %v", output, err)
	}
}

func TestVerifiedNodeScriptRunnerReusesLockedSnapshotAcrossRunsAndRestart(t *testing.T) {
	sourcePath, identity := copyCurrentExecutableWithIdentity(t)
	snapshotRoot := t.TempDir()
	runner := NewVerifiedNodeScriptRunner(snapshotRoot)
	prepared, err := prepareReusableNodeInterpreter(context.Background(), runner, sourcePath, identity)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = prepared.Close() }()
	if _, err := os.OpenFile(prepared.path, os.O_WRONLY, 0); err == nil {
		t.Fatal("verified Node snapshot accepted a writer while cached")
	}
	if err := os.Remove(sourcePath); err != nil {
		t.Fatal(err)
	}
	reused, err := prepareReusableNodeInterpreter(context.Background(), runner, sourcePath, identity)
	if err != nil {
		t.Fatalf("reuse verified Node snapshot without source: %v", err)
	}
	if reused.path != prepared.path {
		t.Fatalf("reused snapshot path = %q, want %q", reused.path, prepared.path)
	}

	restarted := NewVerifiedNodeScriptRunner(snapshotRoot)
	if _, err := prepareReusableNodeInterpreter(context.Background(), restarted, sourcePath, identity); err != nil {
		t.Fatalf("reuse persisted Node snapshot after restart: %v", err)
	}
	if err := restarted.Close(); err != nil {
		t.Fatal(err)
	}
	if err := runner.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(prepared.path); err != nil {
		t.Fatalf("snapshot lock remains after runner close: %v", err)
	}
}

func TestVerifiedNodeScriptRunnerCancelsBeforeSnapshotConstruction(t *testing.T) {
	sourcePath, identity := copyCurrentExecutableWithIdentity(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := prepareReusableNodeInterpreter(ctx, NewVerifiedNodeScriptRunner(t.TempDir()), sourcePath, identity)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled snapshot construction error = %v", err)
	}
}
