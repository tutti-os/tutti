package agentstatus

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestListProbesCursorRuntimeCommand(t *testing.T) {
	service := cursorRuntimeProbeTestService(t, "#!/bin/sh\nif [ \"$1\" = \"acp\" ]; then echo 'cursor acp failed' >&2; exit 7; fi\necho 'cursor-agent 1.0.0'\n")

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"cursor"}})
	if err != nil {
		t.Fatal(err)
	}
	status := onlyStatus(t, snapshot)
	if status.Availability.Status != AvailabilityNotInstalled || status.Availability.ReasonCode != "acp_adapter_launch_failed" {
		t.Fatalf("status = %#v, want adapter launch failure", status)
	}
}

func TestListSkipsCursorRuntimeProbeDuringInstall(t *testing.T) {
	service := cursorRuntimeProbeTestService(t, "#!/bin/sh\nif [ \"$1\" = \"acp\" ]; then echo 'must not run' >&2; exit 7; fi\necho 'cursor-agent 1.0.0'\n")
	installCtx := withActiveActionToken(context.Background(), nextActiveActionToken())
	claimActiveAction(installCtx, "cursor", ActiveAction{ID: ActionInstall, Status: "running"})
	t.Cleanup(func() { clearActiveAction(installCtx, "cursor") })

	snapshot, err := service.List(context.Background(), ListInput{Providers: []string{"cursor"}})
	if err != nil {
		t.Fatal(err)
	}
	if status := onlyStatus(t, snapshot); status.Availability.Status != AvailabilityReady {
		t.Fatalf("availability = %#v, want ready while install probe is skipped", status.Availability)
	}
}

func cursorRuntimeProbeTestService(t *testing.T, script string) Service {
	t.Helper()
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	binary := filepath.Join(binDir, "cursor-agent")
	writeExecutable(t, binary, script)
	return Service{
		Environ: func() []string { return []string{"PATH=" + binDir} },
		FileExists: func(path string) bool {
			_, err := os.Stat(path)
			return err == nil
		},
		HomeDir:          func() (string, error) { return home, nil },
		IsExecutableFile: isTestExecutable,
		LookPath: func(name string) (string, error) {
			if name == "cursor-agent" {
				return binary, nil
			}
			return "", errors.New("not found")
		},
		Now: func() time.Time { return time.Date(2026, 7, 11, 8, 0, 0, 0, time.UTC) },
		// Full-repo Go tests compile many packages concurrently. Give the Wait
		// goroutine enough scheduling headroom while preserving the assertion that
		// this fixture must exit before it can be classified as ready.
		ProbeReadyAfter: 10 * time.Second,
		ProbeTimeout:    12 * time.Second,
		RunAuthStatusCommand: func(context.Context, ProviderSpec, string) (AuthInfo, bool) {
			return AuthInfo{Status: AuthAuthenticated}, true
		},
	}
}
