package main

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func TestRunHelpExitsBeforeCreatingState(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "state")
	t.Setenv("TUTTI_STATE_DIR", stateDir)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if exitCode := run([]string{"--help"}, &stdout, &stderr); exitCode != 0 {
		t.Fatalf("run(--help) exit code = %d, want 0", exitCode)
	}
	if !strings.Contains(stdout.String(), "Usage: tuttid") {
		t.Fatalf("run(--help) stdout = %q", stdout.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("run(--help) stderr = %q, want empty", stderr.String())
	}
	if _, err := os.Stat(stateDir); !os.IsNotExist(err) {
		t.Fatalf("state directory exists after --help: %v", err)
	}
}

func TestRunRejectsUnexpectedArgumentsBeforeCreatingState(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "state")
	t.Setenv("TUTTI_STATE_DIR", stateDir)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if exitCode := run([]string{"--version"}, &stdout, &stderr); exitCode != 2 {
		t.Fatalf("run(--version) exit code = %d, want 2", exitCode)
	}
	if stdout.Len() != 0 {
		t.Fatalf("run(--version) stdout = %q, want empty", stdout.String())
	}
	if !strings.Contains(stderr.String(), "unexpected arguments: --version") {
		t.Fatalf("run(--version) stderr = %q", stderr.String())
	}
	if _, err := os.Stat(stateDir); !os.IsNotExist(err) {
		t.Fatalf("state directory exists after invalid argument: %v", err)
	}
}

func TestContextWithDesktopParentMonitorCancelsWhenParentPIDIsGone(t *testing.T) {
	t.Setenv("TUTTI_DESKTOP_PARENT_PID", "999999999")

	ctx, cancel := contextWithDesktopParentMonitor(context.Background(), testLogger())
	defer cancel()

	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("parent monitor did not cancel after missing parent pid")
	}
}

func TestContextWithDesktopParentMonitorKeepsStandaloneDaemonRunning(t *testing.T) {
	t.Setenv("TUTTI_DESKTOP_PARENT_PID", "")

	ctx, cancel := contextWithDesktopParentMonitor(context.Background(), testLogger())
	defer cancel()

	select {
	case <-ctx.Done():
		t.Fatal("standalone daemon context cancelled unexpectedly")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestContextWithDesktopParentMonitorAcceptsLiveParentPID(t *testing.T) {
	t.Setenv("TUTTI_DESKTOP_PARENT_PID", strconv.Itoa(os.Getpid()))

	ctx, cancel := contextWithDesktopParentMonitor(context.Background(), testLogger())
	defer cancel()

	select {
	case <-ctx.Done():
		t.Fatal("live parent context cancelled unexpectedly")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestProcessExists(t *testing.T) {
	if !tuttitypes.ProcessExists(os.Getpid()) {
		t.Fatal("ProcessExists(os.Getpid()) = false")
	}
	if tuttitypes.ProcessExists(-1) {
		t.Fatal("ProcessExists(-1) = true")
	}
}

func TestWiringUsesSupervisedAgentHostRun(t *testing.T) {
	combined := readProductionWiring(t)
	if !strings.Contains(combined, "agentHost.Run(ctx)") {
		t.Fatal("production wiring does not start the supervised Agent Host lifecycle")
	}
	for _, legacy := range []string{
		"agentHost.RunRuntimeOperationWorker(ctx)",
		"agentHost.RunGoalOperationWorker(ctx)",
		"agentHost.RunGoalReconcileInboxWorker(ctx)",
		"agentHost.RunWorktreeGarbageCollectionWorker(ctx)",
	} {
		if strings.Contains(combined, legacy) {
			t.Fatalf("production wiring still starts an unsupervised Host worker: %s", legacy)
		}
	}
}

func TestWiringConnectsWorkspaceAgentSessionResolvers(t *testing.T) {
	combined := readProductionWiring(t)
	for _, wiring := range []string{
		"agentActivityProjection.SetWorkspaceAgentTargetResolver(workspaceAgentsStore)",
		"agentSessionService.WorkspaceAgentResolver = workspaceAgents",
	} {
		if !strings.Contains(combined, wiring) {
			t.Fatalf("production wiring does not connect Workspace Agent session dependency: %s", wiring)
		}
	}
}

func readProductionWiring(t *testing.T) string {
	t.Helper()
	var source strings.Builder
	for _, file := range []string{"wiring.go", "wiring_daemon_api.go"} {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		source.Write(raw)
		source.WriteByte('\n')
	}
	return source.String()
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
