//go:build windows

package agent

import (
	"context"
	"testing"
	"time"
)

func TestCodexAppServerProcessStopsOnWindows(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	process, err := startCodexAppServerProcess(ctx, "cmd.exe", []string{
		"/D",
		"/S",
		"/C",
		"ping 127.0.0.1 -n 20 >NUL",
	}, nil)
	if err != nil {
		t.Fatalf("startCodexAppServerProcess returned error: %v", err)
	}

	startedAt := time.Now()
	cancel()
	if err := process.stop(cancel); err != nil {
		t.Fatalf("stop returned error: %v", err)
	}
	if elapsed := time.Since(startedAt); elapsed > 3*time.Second {
		t.Fatalf("process cleanup took %s, want bounded Windows kill", elapsed)
	}
}
