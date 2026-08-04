package workspace

import (
	"io"
)

// TerminalProcessFactory is the platform boundary owned by TerminalService.
// Implementations must provide equivalent PTY semantics without exposing the
// underlying Unix PTY or Windows ConPTY library to the service.
type TerminalProcessFactory interface {
	DefaultShell() TerminalShellSpec
	Start(shell string, args []string, cwd string, env []string, cols int, rows int) (TerminalProcess, error)
}

type TerminalShellSpec struct {
	Executable string
	Args       []string
}

type TerminalProcess interface {
	io.ReadWriteCloser
	Kill() error
	PID() int
	Resize(cols int, rows int) error
	Wait() error
}
