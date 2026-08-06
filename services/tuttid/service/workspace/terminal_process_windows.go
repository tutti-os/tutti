//go:build windows

package workspace

import (
	"context"
	"fmt"
	"sync"

	"github.com/UserExistsError/conpty"
	"golang.org/x/sys/windows"
)

type platformTerminalProcessFactory struct{}

type terminalProcessExitError struct {
	code int
}

func (e terminalProcessExitError) Error() string {
	return fmt.Sprintf("terminal process exited with code %d", e.code)
}

func NewPlatformTerminalProcessFactory() TerminalProcessFactory {
	return platformTerminalProcessFactory{}
}

func (platformTerminalProcessFactory) DefaultShell() TerminalShellSpec {
	shell := defaultShellPath()
	return TerminalShellSpec{Executable: shell, Args: resolveTerminalShellInvocation(shell)}
}

func defaultShellPath() string {
	return "cmd.exe"
}

func resolveTerminalShellInvocation(string) []string {
	// Disable per-user cmd.exe AutoRun hooks and command echo. AutoRun can
	// replace or wrap the interactive shell, while echo makes callers mistake
	// typed input for command output when synchronizing with the terminal.
	return []string{"/D", "/Q"}
}

func (platformTerminalProcessFactory) Start(shell string, args []string, cwd string, env []string, cols int, rows int) (TerminalProcess, error) {
	commandLine := windows.ComposeCommandLine(append([]string{shell}, args...))
	process, err := conpty.Start(
		commandLine,
		conpty.ConPtyDimensions(cols, rows),
		conpty.ConPtyWorkDir(cwd),
		conpty.ConPtyEnv(env),
	)
	if err != nil {
		return nil, err
	}
	return &windowsTerminalProcess{process: process}, nil
}

type windowsTerminalProcess struct {
	process   *conpty.ConPty
	closeOnce sync.Once
	closeErr  error
}

func (p *windowsTerminalProcess) Read(data []byte) (int, error) { return p.process.Read(data) }
func (p *windowsTerminalProcess) Write(data []byte) (int, error) {
	normalized := normalizeWindowsTerminalInput(data)
	written, err := p.process.Write(normalized)
	if err == nil {
		return len(data), nil
	}
	if written > len(data) {
		written = len(data)
	}
	return written, err
}
func (p *windowsTerminalProcess) PID() int { return p.process.Pid() }
func (p *windowsTerminalProcess) Resize(cols int, rows int) error {
	return p.process.Resize(cols, rows)
}

func (p *windowsTerminalProcess) Wait() error {
	code, err := p.process.Wait(context.Background())
	if err != nil {
		return err
	}
	if code != 0 {
		return terminalProcessExitError{code: int(code)}
	}
	return nil
}

func (p *windowsTerminalProcess) Kill() error { return p.Close() }

func (p *windowsTerminalProcess) Close() error {
	p.closeOnce.Do(func() {
		p.closeErr = p.process.Close()
	})
	return p.closeErr
}

func normalizeWindowsTerminalInput(data []byte) []byte {
	result := make([]byte, 0, len(data))
	for index := 0; index < len(data); index++ {
		if data[index] == '\r' {
			result = append(result, '\r')
			if index+1 < len(data) && data[index+1] == '\n' {
				index++
			}
			continue
		}
		if data[index] != '\n' {
			result = append(result, data[index])
			continue
		}
		result = append(result, '\r')
	}
	return result
}
