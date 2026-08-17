//go:build windows

package computer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const computerDaemonStartTimeout = 5 * time.Second
const computerDaemonProbeTimeout = 1 * time.Second
const computerDaemonDiagnosticTailLimit = 512

type windowsComputerDaemon struct {
	mu          sync.Mutex
	process     *exec.Cmd
	processDone <-chan error
	diagnostics *computerDaemonDiagnosticTail
}

type computerDaemonDiagnosticTail struct {
	mu   sync.Mutex
	tail string
}

func newPlatformComputerDaemon() computerDaemon { return &windowsComputerDaemon{} }

func (d *windowsComputerDaemon) Ensure(ctx context.Context, command []string) error {
	if len(command) == 0 || strings.TrimSpace(command[0]) == "" {
		return errors.New("cua-driver command is not configured")
	}
	executable, err := exec.LookPath(command[0])
	if err != nil {
		return ErrNotInstalled
	}
	if windowsDriverDaemonRunning(ctx, executable) {
		return nil
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	if windowsDriverDaemonRunning(ctx, executable) {
		return nil
	}
	if d.process != nil {
		return waitForWindowsDriverDaemon(ctx, d.processDone, d.diagnostics, func(probeCtx context.Context) bool {
			return windowsDriverDaemonRunning(probeCtx, executable)
		})
	}
	cmd := exec.Command(executable, "serve")
	diagnostics := &computerDaemonDiagnosticTail{}
	cmd.Stdout = io.Discard
	cmd.Stderr = diagnostics
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start cua-driver daemon: %w", err)
	}
	ready := false
	defer func() {
		if ready || cmd.Process == nil {
			return
		}
		// The process is ours. If the bounded readiness probe is cancelled or
		// times out, do not leave a detached cua-driver daemon behind.
		_ = cmd.Process.Kill()
	}()
	processDone := make(chan error, 1)
	d.process = cmd
	d.processDone = processDone
	d.diagnostics = diagnostics
	go func() {
		processDone <- cmd.Wait()
		close(processDone)
		d.mu.Lock()
		if d.process == cmd {
			d.process = nil
			d.processDone = nil
			d.diagnostics = nil
		}
		d.mu.Unlock()
	}()

	if err := waitForWindowsDriverDaemon(ctx, processDone, diagnostics, func(probeCtx context.Context) bool {
		return windowsDriverDaemonRunning(probeCtx, executable)
	}); err != nil {
		return err
	}
	ready = true
	return nil
}

func waitForWindowsDriverDaemon(ctx context.Context, processDone <-chan error, diagnostics *computerDaemonDiagnosticTail, probe func(context.Context) bool) error {
	if ctx == nil {
		ctx = context.Background()
	}
	deadline := time.NewTimer(computerDaemonStartTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if probe(ctx) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-processDone:
			if err != nil {
				return fmt.Errorf("%s: %w", computerDaemonDiagnosticMessage("cua-driver daemon exited before becoming ready", diagnostics), err)
			}
			return errors.New(computerDaemonDiagnosticMessage("cua-driver daemon exited before becoming ready", diagnostics))
		case <-deadline.C:
			return errors.New(computerDaemonDiagnosticMessage("cua-driver daemon did not become ready", diagnostics))
		case <-ticker.C:
		}
	}
}

func (d *computerDaemonDiagnosticTail) Write(content []byte) (int, error) {
	if d == nil {
		return len(content), nil
	}
	summary := computerDaemonStderrSummary(content)
	if summary == "" {
		return len(content), nil
	}
	d.mu.Lock()
	if d.tail != "" {
		d.tail += "; "
	}
	d.tail += summary
	if len(d.tail) > computerDaemonDiagnosticTailLimit {
		d.tail = d.tail[len(d.tail)-computerDaemonDiagnosticTailLimit:]
	}
	d.mu.Unlock()
	return len(content), nil
}

func (d *computerDaemonDiagnosticTail) String() string {
	if d == nil {
		return ""
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.tail
}

func computerDaemonStderrSummary(content []byte) string {
	lower := strings.ToLower(strings.ToValidUTF8(string(content), ""))
	switch {
	case strings.Contains(lower, "address already in use"), strings.Contains(lower, "only one usage of each socket address"):
		return "listen address already in use"
	case strings.Contains(lower, "access is denied"), strings.Contains(lower, "permission denied"):
		return "permission denied"
	case strings.Contains(lower, "invalid config"), strings.Contains(lower, "configuration error"):
		return "invalid driver configuration"
	case strings.Contains(lower, "error"), strings.Contains(lower, "failed"):
		return "driver reported an error"
	case strings.TrimSpace(lower) != "":
		return "driver emitted diagnostic output"
	default:
		return ""
	}
}

func computerDaemonDiagnosticMessage(message string, diagnostics *computerDaemonDiagnosticTail) string {
	if summary := strings.TrimSpace(diagnostics.String()); summary != "" {
		return message + " (" + summary + ")"
	}
	return message
}

func windowsDriverDaemonRunning(ctx context.Context, executable string) bool {
	if ctx == nil {
		ctx = context.Background()
	}
	probeCtx, cancel := context.WithTimeout(ctx, computerDaemonProbeTimeout)
	defer cancel()
	output, err := exec.CommandContext(probeCtx, executable, "status").CombinedOutput()
	return err == nil && strings.Contains(strings.ToLower(string(output)), "daemon is running")
}

func (d *windowsComputerDaemon) Close() error {
	d.mu.Lock()
	process := d.process
	d.process = nil
	d.processDone = nil
	d.diagnostics = nil
	d.mu.Unlock()
	if process == nil || process.Process == nil {
		return nil
	}
	if err := process.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}
