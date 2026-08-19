package agentruntime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
)

type localProcessTransport struct{}

// RunVerifiedExecutable starts a short-lived managed-runtime command from the
// same verified descriptor or immutable snapshot used by the ACP transport.
// Keeping preparation and process start in this package prevents callers from
// reintroducing a pathname gap between identity verification and execution.
func RunVerifiedExecutable(ctx context.Context, path string, args []string, identity *ExecutableIdentity) ([]byte, error) {
	if identity == nil {
		return nil, errors.New("verified process executable identity is required")
	}
	preparedExecutable, err := prepareProcessExecutable(path, identity)
	if err != nil {
		return nil, err
	}
	defer func() { _ = preparedExecutable.Close() }()
	cmd := newManagedProcessCommand(ctx, preparedExecutable.path, args...)
	if preparedExecutable.file != nil {
		cmd.ExtraFiles = []*os.File{preparedExecutable.file}
	}
	return cmd.CombinedOutput()
}

// RunVerifiedExecutableBounded captures only stdout from a verified short-lived
// executable and rejects output beyond maxBytes. Stderr is intentionally not
// returned so provider diagnostics cannot cross a host contract by accident.
func RunVerifiedExecutableBounded(ctx context.Context, path string, args []string, identity *ExecutableIdentity, maxBytes int) ([]byte, error) {
	if identity == nil {
		return nil, errors.New("verified process executable identity is required")
	}
	if maxBytes <= 0 {
		return nil, errors.New("verified process output limit is required")
	}
	preparedExecutable, err := prepareProcessExecutable(path, identity)
	if err != nil {
		return nil, err
	}
	defer func() { _ = preparedExecutable.Close() }()
	cmd := newManagedProcessCommand(ctx, preparedExecutable.path, args...)
	if preparedExecutable.file != nil {
		cmd.ExtraFiles = []*os.File{preparedExecutable.file}
	}
	output := boundedProcessOutput{limit: maxBytes}
	cmd.Stdout = &output
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	if output.overflow {
		return nil, errors.New("verified process output exceeded limit")
	}
	return output.bytes, nil
}

// RunVerifiedNodeScriptBounded verifies a fixed Node interpreter and a
// provider-owned JavaScript file independently. The verified script bytes are
// supplied on stdin, so execution never depends on reopening a mutable script
// pathname or on platform-specific npm shims.
func RunVerifiedNodeScriptBounded(
	ctx context.Context,
	nodePath string,
	scriptPath string,
	args []string,
	nodeIdentity *ExecutableIdentity,
	scriptIdentity *ExecutableIdentity,
	maxBytes int,
) ([]byte, error) {
	return NewVerifiedNodeScriptRunner("").Run(
		ctx, nodePath, scriptPath, args, nodeIdentity, scriptIdentity, maxBytes,
	)
}

// VerifiedNodeScriptRunner reuses verified Node snapshots when the platform
// cannot safely execute an already-open interpreter descriptor. snapshotRoot
// must be daemon-owned private state when reuse across probes is required.
type VerifiedNodeScriptRunner struct {
	snapshotRoot      string
	snapshotMu        sync.Mutex
	verifiedSnapshots map[string]*os.File
}

func NewVerifiedNodeScriptRunner(snapshotRoot string) *VerifiedNodeScriptRunner {
	return &VerifiedNodeScriptRunner{snapshotRoot: strings.TrimSpace(snapshotRoot)}
}

func (runner *VerifiedNodeScriptRunner) Close() error {
	if runner == nil {
		return nil
	}
	runner.snapshotMu.Lock()
	defer runner.snapshotMu.Unlock()
	var closeErr error
	for identity, file := range runner.verifiedSnapshots {
		closeErr = errors.Join(closeErr, file.Close())
		delete(runner.verifiedSnapshots, identity)
	}
	return closeErr
}

func (runner *VerifiedNodeScriptRunner) Run(
	ctx context.Context,
	nodePath string,
	scriptPath string,
	args []string,
	nodeIdentity *ExecutableIdentity,
	scriptIdentity *ExecutableIdentity,
	maxBytes int,
) ([]byte, error) {
	if nodeIdentity == nil || scriptIdentity == nil {
		return nil, errors.New("verified Node interpreter and script identities are required")
	}
	if maxBytes <= 0 {
		return nil, errors.New("verified process output limit is required")
	}
	script, err := readVerifiedProcessInput(ctx, scriptPath, scriptIdentity, 16<<20)
	if err != nil {
		return nil, err
	}
	preparedNode, err := prepareReusableNodeInterpreter(ctx, runner, nodePath, nodeIdentity)
	if err != nil {
		return nil, err
	}
	defer func() { _ = preparedNode.Close() }()
	nodeArgs := append([]string{"--input-type=commonjs", "-"}, args...)
	cmd := newManagedProcessCommand(ctx, preparedNode.path, nodeArgs...)
	if preparedNode.file != nil {
		cmd.ExtraFiles = []*os.File{preparedNode.file}
	}
	cmd.Stdin = bytes.NewReader(script)
	output := boundedProcessOutput{limit: maxBytes}
	cmd.Stdout = &output
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	if output.overflow {
		return nil, errors.New("verified process output exceeded limit")
	}
	return output.bytes, nil
}

func readVerifiedProcessInput(ctx context.Context, path string, expected *ExecutableIdentity, maxBytes int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validProcessInputIdentity(expected) || maxBytes <= 0 || expected.SizeBytes > maxBytes {
		return nil, errors.New("verified process input identity is invalid")
	}
	pathInfo, err := os.Lstat(path)
	if err != nil || !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("verified process input is not an ordinary file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open verified process input: %w", err)
	}
	defer func() { _ = file.Close() }()
	fileInfo, err := file.Stat()
	if err != nil || !fileInfo.Mode().IsRegular() || !os.SameFile(pathInfo, fileInfo) {
		return nil, errors.New("verified process input changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(&contextReader{ctx: ctx, reader: file}, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read verified process input: %w", err)
	}
	if int64(len(data)) != expected.SizeBytes {
		return nil, errors.New("verified process input does not match expected identity")
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != expected.SHA256 {
		return nil, errors.New("verified process input does not match expected identity")
	}
	return data, nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader *contextReader) Read(value []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	count, err := reader.reader.Read(value)
	if err == nil {
		if contextErr := reader.ctx.Err(); contextErr != nil {
			return count, contextErr
		}
	}
	return count, err
}

func validProcessInputIdentity(identity *ExecutableIdentity) bool {
	if identity == nil || identity.SizeBytes <= 0 || len(identity.SHA256) != sha256.Size*2 || identity.SHA256 != strings.ToLower(identity.SHA256) {
		return false
	}
	_, err := hex.DecodeString(identity.SHA256)
	return err == nil
}

type boundedProcessOutput struct {
	bytes    []byte
	limit    int
	overflow bool
}

func (output *boundedProcessOutput) Write(value []byte) (int, error) {
	remaining := output.limit - len(output.bytes)
	if remaining > 0 {
		count := len(value)
		if count > remaining {
			count = remaining
		}
		output.bytes = append(output.bytes, value[:count]...)
	}
	if len(value) > remaining {
		output.overflow = true
	}
	return len(value), nil
}

type localProcessConnection struct {
	cancel             context.CancelFunc
	cmd                *exec.Cmd
	preparedExecutable *preparedProcessExecutable
	done               chan struct{}
	closing            chan struct{}
	frames             chan ProcessFrame
	stdin              io.WriteCloser

	closeMu     sync.Mutex
	closingOnce sync.Once
	sendMu      sync.Mutex
	inputOnce   sync.Once
}

func NewLocalProcessTransport() ProcessTransport {
	return localProcessTransport{}
}

func (localProcessTransport) Start(ctx context.Context, spec ProcessSpec) (ProcessConnection, error) {
	if len(spec.Command) == 0 || spec.Command[0] == "" {
		return nil, errors.New("process command is required")
	}
	if len(spec.SensitiveInheritedFiles) != 0 {
		return nil, errors.New("sensitive inherited files require the connector process transport")
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
	preparedExecutable, err := prepareProcessExecutable(resolvedCommand, spec.ExecutableIdentity)
	if err != nil {
		cancel()
		return nil, err
	}
	started := false
	defer func() {
		if !started {
			_ = preparedExecutable.Close()
		}
	}()
	cmd := newManagedProcessCommand(processCtx, preparedExecutable.path, spec.Command[1:]...)
	if preparedExecutable.file != nil {
		cmd.ExtraFiles = []*os.File{preparedExecutable.file}
	}
	cmd.Env = env
	if cwd := strings.TrimSpace(spec.CWD); cwd != "" {
		cmd.Dir = cwd
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
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
	}
	// Let os/exec own the stdout/stderr copy goroutines. Wait then guarantees
	// that both writers have consumed their final bytes before it returns,
	// without making process reaping depend on pipe EOF. In particular, this
	// preserves startup-time streaming for long-lived sidecars while keeping a
	// short-lived process's final output ordered before its exit frame.
	cmd.Stdout = processFrameWriter{conn: conn, stdout: true}
	cmd.Stderr = processFrameWriter{conn: conn}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		cancel()
		return nil, err
	}
	conn.preparedExecutable = &preparedExecutable
	started = true

	go conn.wait()
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

func (c *localProcessConnection) RecvContext(ctx context.Context) (ProcessFrame, error) {
	if c == nil {
		return ProcessFrame{}, io.EOF
	}
	select {
	case <-ctx.Done():
		return ProcessFrame{}, ctx.Err()
	case frame, ok := <-c.frames:
		if !ok {
			return ProcessFrame{}, io.EOF
		}
		return frame, nil
	}
}

func (c *localProcessConnection) Close() error {
	if c == nil {
		return nil
	}
	c.closeMu.Lock()
	defer c.closeMu.Unlock()
	if c.waitDone(0) {
		return nil
	}
	c.closingOnce.Do(func() { close(c.closing) })
	return closeLocalProcessAttempt(c.waitDone, c.CloseInput, c.Terminate, c.Kill)
}

func closeLocalProcessAttempt(
	waitDone func(time.Duration) bool,
	closeInput func() error,
	terminate func() error,
	kill func() error,
) error {
	_ = closeInput()
	if waitDone(250 * time.Millisecond) {
		return nil
	}
	_ = terminate()
	if waitDone(750 * time.Millisecond) {
		return nil
	}
	killErr := kill()
	if waitDone(2 * time.Second) {
		return nil
	}
	return errors.Join(killErr, errors.New("process did not exit after kill"))
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
	return terminateManagedProcess(c.cmd)
}

func (c *localProcessConnection) Kill() error {
	if c == nil {
		return nil
	}
	if c.cmd == nil || c.cmd.Process == nil {
		c.cancel()
		return nil
	}
	err := killManagedProcessTree(c.cmd)
	c.cancel()
	return err
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

type processFrameWriter struct {
	conn   *localProcessConnection
	stdout bool
}

func (w processFrameWriter) Write(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	chunk := append([]byte(nil), data...)
	frame := ProcessFrame{}
	if w.stdout {
		frame.Stdout = chunk
	} else {
		frame.Stderr = chunk
	}
	w.conn.sendFrame(frame)
	return len(data), nil
}

func (c *localProcessConnection) wait() {
	err := c.cmd.Wait()
	if c.preparedExecutable != nil {
		_ = c.preparedExecutable.Close()
		c.preparedExecutable = nil
	}
	exitCode := 0
	if err != nil {
		exitCode = 1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
	}
	c.sendFrame(ProcessFrame{ExitCode: &exitCode})
	close(c.frames)
	close(c.done)
}

// sendFrame preserves the output ordering guarantee even when Close has
// started. Once closing is signaled, a send and the close signal are both
// ready; choosing between them directly would make final stdout/stderr
// diagnostics disappear nondeterministically. Prefer an available queue slot
// before observing closing, and make one last non-blocking attempt after the
// connection starts closing.
func (c *localProcessConnection) sendFrame(frame ProcessFrame) {
	select {
	case c.frames <- frame:
		return
	default:
	}

	select {
	case c.frames <- frame:
		return
	case <-c.closing:
		select {
		case c.frames <- frame:
		default:
		}
	}
}
