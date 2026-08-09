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

type windowsComputerDaemon struct {
	mu      sync.Mutex
	process *exec.Cmd
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
		return errors.New("cua-driver daemon failed to become ready")
	}
	cmd := exec.Command(executable, "serve")
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
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
	d.process = cmd
	go func() {
		_ = cmd.Wait()
		d.mu.Lock()
		if d.process == cmd {
			d.process = nil
		}
		d.mu.Unlock()
	}()

	deadline := time.NewTimer(computerDaemonStartTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if windowsDriverDaemonRunning(ctx, executable) {
			ready = true
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("cua-driver daemon did not become ready")
		case <-ticker.C:
		}
	}
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
	d.mu.Unlock()
	if process == nil || process.Process == nil {
		return nil
	}
	if err := process.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	return nil
}
