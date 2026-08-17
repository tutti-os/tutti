package agent

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
)

type codexAppServerProcess struct {
	stdin    io.WriteCloser
	stdout   *io.PipeReader
	stderr   *truncatingBuffer
	waitDone chan struct{}
	stopOnce sync.Once
	stopErr  error
}

func startCodexAppServerProcess(
	ctx context.Context,
	command string,
	args []string,
	env []string,
) (*codexAppServerProcess, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Env = env
	cmd.WaitDelay = codexAppServerShutdownWaitDelay
	prepareCodexAppServerCommand(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("open codex app-server stdin: %w", err)
	}
	stdout, stdoutWriter := io.Pipe()
	cmd.Stdout = stdoutWriter
	stderr := &truncatingBuffer{max: codexModelListMaxStderrBytes}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stdoutWriter.Close()
		return nil, fmt.Errorf("start codex app-server: %w", err)
	}

	waitDone := make(chan struct{})
	process := &codexAppServerProcess{
		stdin:    stdin,
		stdout:   stdout,
		stderr:   stderr,
		waitDone: waitDone,
	}
	go func() {
		_ = cmd.Wait()
		_ = stdoutWriter.Close()
		close(waitDone)
	}()
	return process, nil
}

func (p *codexAppServerProcess) stop(cancel context.CancelFunc) error {
	if p == nil {
		cancel()
		return nil
	}
	p.stopOnce.Do(func() {
		_ = p.stdin.Close()
		cancel()
		// A response parser can finish before the app-server exits. Closing the
		// reader keeps os/exec's stdout copier from making process reaping depend
		// on unread provider notifications.
		_ = p.stdout.Close()
		<-p.waitDone
		// stop is an intentional shutdown path. A context cancellation normally
		// makes os/exec report SIGKILL/ExitError; that is not a cleanup failure.
		p.stopErr = nil
	})
	return p.stopErr
}
