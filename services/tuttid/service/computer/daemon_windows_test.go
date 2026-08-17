//go:build windows

package computer

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestWaitForWindowsDriverDaemonRetriesUntilReady(t *testing.T) {
	probes := 0
	err := waitForWindowsDriverDaemon(context.Background(), nil, nil, func(context.Context) bool {
		probes++
		return probes == 2
	})

	if err != nil {
		t.Fatalf("waitForWindowsDriverDaemon() error = %v", err)
	}
	if probes != 2 {
		t.Fatalf("probe count = %d, want 2", probes)
	}
}

func TestWaitForWindowsDriverDaemonReportsEarlyExit(t *testing.T) {
	processDone := make(chan error, 1)
	processDone <- errors.New("exit status 1")
	diagnostics := &computerDaemonDiagnosticTail{}
	_, _ = diagnostics.Write([]byte("Error: token sk-secret: address already in use"))

	err := waitForWindowsDriverDaemon(context.Background(), processDone, diagnostics, func(context.Context) bool {
		return false
	})

	if err == nil || !strings.Contains(err.Error(), "exited before becoming ready (listen address already in use): exit status 1") {
		t.Fatalf("waitForWindowsDriverDaemon() error = %v", err)
	}
	if strings.Contains(err.Error(), "sk-secret") {
		t.Fatalf("waitForWindowsDriverDaemon() error leaked stderr: %v", err)
	}
}

func TestComputerDaemonDiagnosticTailClassifiesWithoutLeakingStderr(t *testing.T) {
	diagnostics := &computerDaemonDiagnosticTail{}
	_, _ = diagnostics.Write([]byte("permission denied for user@example.com at C:\\Users\\private"))

	if got, want := diagnostics.String(), "permission denied"; got != want {
		t.Fatalf("diagnostics.String() = %q, want %q", got, want)
	}
}
