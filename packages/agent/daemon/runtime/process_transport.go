package agentruntime

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/runtimecmd"
)

type localProcessTransport struct{}

type localProcessConnection struct {
	cancel  context.CancelFunc
	cmd     *exec.Cmd
	done    chan struct{}
	closing chan struct{}
	frames  chan ProcessFrame
	stdin   io.WriteCloser
	stdout  io.Closer
	stderr  io.Closer

	closeOnce sync.Once
	sendMu    sync.Mutex
	inputOnce sync.Once
	closeErr  error
}

func NewLocalProcessTransport() ProcessTransport {
	return localProcessTransport{}
}

func (localProcessTransport) Start(ctx context.Context, spec ProcessSpec) (ProcessConnection, error) {
	if len(spec.Command) == 0 || spec.Command[0] == "" {
		return nil, errors.New("process command is required")
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	processCtx, cancel := context.WithCancel(context.Background())
	resolver := runtimecmd.Resolver{}
	env := resolver.Env(spec.Env)
	resolvedCommand := resolver.Resolve(spec.Command[0], env)
	logProcessStartEnvDiagnostics(spec, env, resolvedCommand)
	cmd := exec.CommandContext(processCtx, resolvedCommand, spec.Command[1:]...)
	cmd.Env = env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, err
	}

	conn := &localProcessConnection{
		cancel:  cancel,
		cmd:     cmd,
		done:    make(chan struct{}),
		closing: make(chan struct{}),
		frames:  make(chan ProcessFrame, 16),
		stdin:   stdin,
		stdout:  stdout,
		stderr:  stderr,
	}
	var readers sync.WaitGroup
	readers.Add(2)
	go conn.readPipe(&readers, stdout, true)
	go conn.readPipe(&readers, stderr, false)
	go conn.wait(&readers)
	return conn, nil
}

func logProcessStartEnvDiagnostics(spec ProcessSpec, env []string, resolvedCommand string) {
	diag := processStartEnvDiagnostics(spec, env)
	slog.Info("agent session process start env diagnostics",
		"event", "agent_session.process_start.env_diagnostics",
		"provider", spec.Provider,
		"room_id", spec.RoomID,
		"agent_session_id", spec.AgentSessionID,
		"cwd", spec.CWD,
		"command", commandNameForLog(spec.Command),
		"resolved_command", resolvedCommand,
		"path_override_count", diag["path_override_count"],
		"path_entry_count", diag["path_entry_count"],
		"path_head", diag["path_head"],
		"path_contains_tutti_bin", diag["path_contains_tutti_bin"],
		"path_contains_app_node_bin", diag["path_contains_app_node_bin"],
		"path_contains_app_npm_bin", diag["path_contains_app_npm_bin"],
		"workspace_env_present", diag["workspace_env_present"],
		"agent_session_env_present", diag["agent_session_env_present"],
		"proxy_env_present", diag["proxy_env_present"],
		"proxy_source", diag["proxy_source"],
	)
}

func processStartEnvDiagnostics(spec ProcessSpec, env []string) map[string]any {
	pathValue := envValueFromList(env, "PATH")
	pathDirs := filepath.SplitList(pathValue)
	appNodeBin := filepath.Dir(envValueFromList(env, "TUTTI_APP_NODE"))
	appNPMBin := filepath.Dir(envValueFromList(env, "TUTTI_APP_NPM"))
	proxyPresent, proxySource := proxyDiagnostics(spec, env)
	return map[string]any{
		"path_override_count":        envKeyCount(spec.Env, "PATH"),
		"path_entry_count":           len(pathDirs),
		"path_head":                  pathHeadForLog(pathDirs, 6),
		"path_contains_tutti_bin":    pathContainsTuttiBin(pathDirs),
		"path_contains_app_node_bin": appNodeBin != "." && pathContainsDir(pathDirs, appNodeBin),
		"path_contains_app_npm_bin":  appNPMBin != "." && pathContainsDir(pathDirs, appNPMBin),
		"workspace_env_present":      envHasKey(env, "TUTTI_WORKSPACE_ID"),
		"agent_session_env_present":  envHasKey(env, "TUTTI_AGENT_SESSION_ID"),
		"proxy_env_present":          proxyPresent,
		"proxy_source":               proxySource,
	}
}

// proxyEnvKeys are checked case-insensitively; envValueFromList uses EqualFold
// so lowercase shell-style spellings match too.
var proxyEnvKeys = []string{"HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"}

// proxyDiagnostics reports whether the spawned agent sees a proxy and where it
// came from: "env" when the daemon process env or session overrides carry one
// (user shell/session explicit), "system" when only the injected macOS system
// proxy supplies it, "none" otherwise.
func proxyDiagnostics(spec ProcessSpec, env []string) (bool, string) {
	present := false
	for _, key := range proxyEnvKeys {
		if envHasKey(env, key) {
			present = true
			break
		}
	}
	if !present {
		return false, "none"
	}
	processEnv := os.Environ()
	for _, key := range proxyEnvKeys {
		if envHasKey(spec.Env, key) || envHasKey(processEnv, key) {
			return true, "env"
		}
	}
	return true, "system"
}

func commandNameForLog(command []string) string {
	if len(command) == 0 {
		return ""
	}
	return command[0]
}

func pathHeadForLog(dirs []string, limit int) []string {
	if limit <= 0 || len(dirs) == 0 {
		return nil
	}
	if len(dirs) < limit {
		limit = len(dirs)
	}
	head := make([]string, 0, limit)
	for _, dir := range dirs[:limit] {
		if dir = filepath.Clean(dir); dir != "." {
			head = append(head, dir)
		}
	}
	return head
}

func pathContainsTuttiBin(dirs []string) bool {
	for _, dir := range dirs {
		if filepath.Base(filepath.Clean(dir)) == "bin" && filepath.Base(filepath.Dir(filepath.Clean(dir))) == ".tutti" {
			return true
		}
	}
	return false
}

func pathContainsDir(dirs []string, want string) bool {
	want = filepath.Clean(want)
	for _, dir := range dirs {
		if filepath.Clean(dir) == want {
			return true
		}
	}
	return false
}

func envHasKey(env []string, key string) bool {
	return envValueFromList(env, key) != ""
}

func envKeyCount(env []string, key string) int {
	count := 0
	for _, item := range env {
		candidateKey, _, ok := strings.Cut(item, "=")
		if ok && strings.EqualFold(candidateKey, key) {
			count++
		}
	}
	return count
}

func envValueFromList(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		candidateKey, value, ok := strings.Cut(env[i], "=")
		if ok && strings.EqualFold(candidateKey, key) {
			return value
		}
	}
	return ""
}

func (c *localProcessConnection) Send(data []byte) error {
	if c == nil || c.stdin == nil {
		return io.ErrClosedPipe
	}
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	_, err := c.stdin.Write(data)
	return err
}

func (c *localProcessConnection) Recv() (ProcessFrame, error) {
	if c == nil {
		return ProcessFrame{}, io.EOF
	}
	frame, ok := <-c.frames
	if !ok {
		return ProcessFrame{}, io.EOF
	}
	return frame, nil
}

func (c *localProcessConnection) Close() error {
	if c == nil {
		return nil
	}
	c.closeOnce.Do(func() {
		close(c.closing)
		_ = c.CloseInput()
		if !c.waitDone(250 * time.Millisecond) {
			_ = c.Terminate()
		}
		if !c.waitDone(750 * time.Millisecond) {
			killErr := c.Kill()
			if !c.waitDone(2 * time.Second) {
				if killErr != nil {
					c.closeErr = killErr
					return
				}
				c.closeErr = errors.New("process did not exit after kill")
				return
			}
		}
	})
	if c.closeErr != nil {
		return c.closeErr
	}
	<-c.done
	return nil
}

func (c *localProcessConnection) CloseInput() error {
	if c == nil || c.stdin == nil {
		return nil
	}
	var err error
	c.inputOnce.Do(func() {
		err = c.stdin.Close()
	})
	return err
}

func (c *localProcessConnection) Terminate() error {
	if c == nil || c.cmd == nil || c.cmd.Process == nil {
		return nil
	}
	return c.cmd.Process.Signal(syscall.SIGTERM)
}

func (c *localProcessConnection) Kill() error {
	if c == nil {
		return nil
	}
	c.cancel()
	if c.cmd == nil || c.cmd.Process == nil {
		return nil
	}
	return c.cmd.Process.Kill()
}

func (c *localProcessConnection) waitDone(timeout time.Duration) bool {
	if c == nil {
		return true
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-c.done:
		return true
	case <-timer.C:
		return false
	}
}

func (c *localProcessConnection) readPipe(readers *sync.WaitGroup, reader io.Reader, stdout bool) {
	defer readers.Done()
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			frame := ProcessFrame{}
			if stdout {
				frame.Stdout = chunk
			} else {
				frame.Stderr = chunk
			}
			select {
			case c.frames <- frame:
			case <-c.closing:
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (c *localProcessConnection) wait(readers *sync.WaitGroup) {
	err := c.cmd.Wait()
	readers.Wait()
	exitCode := 0
	if err != nil {
		exitCode = 1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
	}
	c.frames <- ProcessFrame{ExitCode: &exitCode}
	close(c.frames)
	close(c.done)
}
