//go:build !windows

package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/creack/pty"
)

type platformTerminalProcessFactory struct{}

func NewPlatformTerminalProcessFactory() TerminalProcessFactory {
	return platformTerminalProcessFactory{}
}

func (platformTerminalProcessFactory) DefaultShell() TerminalShellSpec {
	shell := defaultShellPath()
	return TerminalShellSpec{Executable: shell, Args: resolveTerminalShellInvocation(shell)}
}

func defaultShellPath() string {
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell
	}
	return "/bin/sh"
}

func resolveTerminalShellInvocation(shell string) []string {
	switch filepath.Base(strings.TrimSpace(shell)) {
	case "bash", "zsh":
		return []string{"-il"}
	case "fish":
		return []string{"-l", "-i"}
	default:
		return nil
	}
}

func (platformTerminalProcessFactory) Start(shell string, args []string, cwd string, env []string, cols int, rows int) (TerminalProcess, error) {
	command := exec.Command(shell, args...)
	command.Dir = cwd
	command.Env = env
	file, err := pty.StartWithSize(command, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	return &unixTerminalProcess{command: command, file: file}, nil
}

type unixTerminalProcess struct {
	command *exec.Cmd
	file    *os.File
}

func (p *unixTerminalProcess) Read(data []byte) (int, error)  { return p.file.Read(data) }
func (p *unixTerminalProcess) Write(data []byte) (int, error) { return p.file.Write(data) }
func (p *unixTerminalProcess) Close() error                   { return p.file.Close() }
func (p *unixTerminalProcess) terminalFD() uintptr            { return p.file.Fd() }
func (p *unixTerminalProcess) PID() int                       { return p.command.Process.Pid }
func (p *unixTerminalProcess) Wait() error                    { return p.command.Wait() }

func (p *unixTerminalProcess) Kill() error {
	if p.command.Process == nil {
		return nil
	}
	return p.command.Process.Kill()
}

func (p *unixTerminalProcess) Resize(cols int, rows int) error {
	return pty.Setsize(p.file, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}
