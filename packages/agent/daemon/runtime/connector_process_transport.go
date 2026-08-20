package agentruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	defaultConnectorStdoutLimit = int64(64 * 1024 * 1024)
	defaultConnectorStderrLimit = int64(16 * 1024 * 1024)
	connectorFDEnvPrefix        = "TUTTI_CONNECTOR_FD_"
)

// ErrProcessSpecInvalid marks a deterministic connector process contract
// violation. The same spec can never succeed on retry, so callers must map it
// to a terminal failure instead of scheduling another attempt.
var ErrProcessSpecInvalid = errors.New("connector process spec is invalid")

type connectorProcessTransport struct {
	stdoutLimit int64
	stderrLimit int64
}

// NewConnectorProcessTransport returns the bounded, receipt-verifying
// transport used for connector installation probes, MCP, and authorization
// broker processes. Agent-invoked Connector CLIs use their stable PATH shim
// instead. Connector processes intentionally do not use an OS
// process sandbox; authority is constrained by signed package identity,
// executable identity, explicit environment, timeouts, and output limits.
func NewConnectorProcessTransport() (ProcessTransport, error) {
	return newConnectorProcessTransport(defaultConnectorStdoutLimit, defaultConnectorStderrLimit), nil
}

func newConnectorProcessTransport(stdoutLimit, stderrLimit int64) ProcessTransport {
	return connectorProcessTransport{stdoutLimit: stdoutLimit, stderrLimit: stderrLimit}
}

func (transport connectorProcessTransport) Start(ctx context.Context, spec ProcessSpec) (ProcessConnection, error) {
	if err := validateConnectorProcessSpec(spec); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	preparedExecutable, err := prepareProcessExecutable(spec.Command[0], spec.ExecutableIdentity)
	if err != nil {
		return nil, err
	}
	started := false
	defer func() {
		if !started {
			_ = preparedExecutable.Close()
		}
	}()

	processCtx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(processCtx, preparedExecutable.path, spec.Command[1:]...)
	if preparedExecutable.file != nil {
		cmd.ExtraFiles = append(cmd.ExtraFiles, preparedExecutable.file)
	}
	// A non-nil empty slice is intentional: connector processes inherit no
	// daemon environment. The host must pass every allowed value explicitly.
	cmd.Env = append([]string{}, spec.Env...)
	if cwd := strings.TrimSpace(spec.CWD); cwd != "" {
		cmd.Dir = cwd
	}
	if err := addSensitiveInheritedFiles(cmd, &spec); err != nil {
		cancel()
		return nil, err
	}
	prepareConnectorProcessGroup(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	connection := &connectorProcessConnection{
		cancel:             cancel,
		cmd:                cmd,
		preparedExecutable: &preparedExecutable,
		done:               make(chan struct{}),
		closing:            make(chan struct{}),
		frames:             make(chan ProcessFrame, 16),
		stdin:              stdin,
		stdoutLimit:        transport.stdoutLimit,
		stderrLimit:        transport.stderrLimit,
	}
	cmd.Stdout = connectorFrameWriter{connection: connection, stdout: true}
	cmd.Stderr = connectorFrameWriter{connection: connection}
	// Keep this immediately adjacent to Start: the signed receipt is rechecked
	// after every other launch preparation step and before the child
	// can observe its entrypoint or modules.
	if err := verifyConnectorArtifactTrees(spec.ArtifactTrees); err != nil {
		_ = stdin.Close()
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		cancel()
		return nil, err
	}
	started = true
	go connection.wait()
	return connection, nil
}

func verifyConnectorArtifactTrees(identities []ArtifactTreeIdentity) error {
	for _, identity := range identities {
		if !filepath.IsAbs(identity.Root) || len(identity.SHA256) != sha256.Size*2 || strings.ToLower(identity.SHA256) != identity.SHA256 {
			return errors.New("connector artifact tree identity is invalid")
		}
		if _, err := hex.DecodeString(identity.SHA256); err != nil {
			return errors.New("connector artifact tree identity is invalid")
		}
		actual, err := connectorTreeInventoryDigest(identity.Root)
		if err != nil {
			return fmt.Errorf("verify connector artifact tree: %w", err)
		}
		if actual != identity.SHA256 {
			return errors.New("connector artifact tree changed before launch")
		}
	}
	return nil
}

func connectorTreeInventoryDigest(root string) (string, error) {
	hash := sha256.New()
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == "." || relative == ".tutti-connector-receipt.json" {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("connector artifact tree contains an unsupported file type")
		}
		_, _ = io.WriteString(hash, filepath.ToSlash(relative))
		_, _ = hash.Write([]byte{0})
		if entry.IsDir() {
			_, _ = hash.Write([]byte("dir\x00"))
			return nil
		}
		_, _ = io.WriteString(hash, fmt.Sprintf("file\x00%d\x00", info.Size()))
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		return errors.Join(copyErr, closeErr)
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func validateConnectorProcessSpec(spec ProcessSpec) error {
	if len(spec.Command) == 0 || strings.TrimSpace(spec.Command[0]) == "" {
		return fmt.Errorf("%w: connector process command is required", ErrProcessSpecInvalid)
	}
	if !filepath.IsAbs(spec.Command[0]) {
		return fmt.Errorf("%w: connector process executable must be absolute", ErrProcessSpecInvalid)
	}
	if spec.ExecutableIdentity == nil || strings.TrimSpace(spec.ExecutableIdentity.SHA256) == "" || spec.ExecutableIdentity.SizeBytes <= 0 {
		return fmt.Errorf("%w: connector process executable identity is required", ErrProcessSpecInvalid)
	}
	environmentKeys := make(map[string]struct{}, len(spec.Env))
	for _, item := range spec.Env {
		key, _, ok := strings.Cut(item, "=")
		if !ok || !validConnectorEnvironmentKey(key) {
			return fmt.Errorf("%w: connector process environment entries must be explicit key=value pairs", ErrProcessSpecInvalid)
		}
		if strings.HasPrefix(strings.ToUpper(key), connectorFDEnvPrefix) {
			return fmt.Errorf("%w: connector process environment key %q uses a host-reserved prefix", ErrProcessSpecInvalid, key)
		}
		normalizedKey := strings.ToUpper(key)
		if _, exists := environmentKeys[normalizedKey]; exists {
			return fmt.Errorf("%w: connector process environment key %q is duplicated", ErrProcessSpecInvalid, key)
		}
		environmentKeys[normalizedKey] = struct{}{}
	}
	return nil
}

func validConnectorEnvironmentKey(key string) bool {
	if key == "" || key != strings.TrimSpace(key) {
		return false
	}
	for index, char := range key {
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char == '_' || (index > 0 && char >= '0' && char <= '9') {
			continue
		}
		return false
	}
	return true
}

func addSensitiveInheritedFiles(cmd *exec.Cmd, spec *ProcessSpec) error {
	seen := make(map[string]struct{}, len(spec.Env)+len(spec.SensitiveInheritedFiles))
	for _, item := range spec.Env {
		key, _, _ := strings.Cut(item, "=")
		seen[strings.ToUpper(key)] = struct{}{}
	}
	for _, inherited := range spec.SensitiveInheritedFiles {
		key := strings.ToUpper(strings.TrimSpace(inherited.DescriptorEnvKey))
		if inherited.File == nil || strings.TrimSpace(inherited.Purpose) == "" {
			return fmt.Errorf("%w: connector sensitive inherited file and purpose are required", ErrProcessSpecInvalid)
		}
		if !strings.HasPrefix(key, connectorFDEnvPrefix) || strings.ContainsAny(key, "=\x00") {
			return fmt.Errorf("%w: connector sensitive descriptor environment key %q is invalid", ErrProcessSpecInvalid, inherited.DescriptorEnvKey)
		}
		if _, exists := seen[key]; exists {
			return fmt.Errorf("%w: connector sensitive descriptor environment key %q is duplicated", ErrProcessSpecInvalid, key)
		}
		seen[key] = struct{}{}
		cmd.ExtraFiles = append(cmd.ExtraFiles, inherited.File)
		// ExtraFiles always begin at fd 3. A verified executable descriptor, when
		// used, occupies the first slot and must be included in the offset.
		fd := 3 + len(cmd.ExtraFiles) - 1
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%d", key, fd))
	}
	return nil
}

type connectorProcessConnection struct {
	cancel             context.CancelFunc
	cmd                *exec.Cmd
	preparedExecutable *preparedProcessExecutable
	done               chan struct{}
	closing            chan struct{}
	frames             chan ProcessFrame
	stdin              io.WriteCloser
	stdoutLimit        int64
	stderrLimit        int64

	closeMu     sync.Mutex
	closingOnce sync.Once
	inputOnce   sync.Once
	sendMu      sync.Mutex
	outputMu    sync.Mutex
	stdout      int64
	stderr      int64
	limitErr    error
}

func (connection *connectorProcessConnection) Send(data []byte) error {
	if connection == nil || connection.stdin == nil {
		return io.ErrClosedPipe
	}
	connection.sendMu.Lock()
	defer connection.sendMu.Unlock()
	_, err := connection.stdin.Write(data)
	return err
}

func (connection *connectorProcessConnection) Recv() (ProcessFrame, error) {
	if connection == nil {
		return ProcessFrame{}, io.EOF
	}
	frame, ok := <-connection.frames
	if ok {
		return frame, nil
	}
	connection.outputMu.Lock()
	err := connection.limitErr
	connection.outputMu.Unlock()
	if err != nil {
		return ProcessFrame{}, err
	}
	return ProcessFrame{}, io.EOF
}

func (connection *connectorProcessConnection) RecvContext(ctx context.Context) (ProcessFrame, error) {
	if connection == nil {
		return ProcessFrame{}, io.EOF
	}
	select {
	case <-ctx.Done():
		return ProcessFrame{}, ctx.Err()
	case frame, ok := <-connection.frames:
		if ok {
			return frame, nil
		}
		connection.outputMu.Lock()
		err := connection.limitErr
		connection.outputMu.Unlock()
		if err != nil {
			return ProcessFrame{}, err
		}
		return ProcessFrame{}, io.EOF
	}
}

func (connection *connectorProcessConnection) Close() error {
	if connection == nil {
		return nil
	}
	connection.closeMu.Lock()
	defer connection.closeMu.Unlock()
	if connection.waitDone(0) {
		return nil
	}
	connection.closingOnce.Do(func() { close(connection.closing) })
	_ = connection.CloseInput()
	if connection.waitDone(250 * time.Millisecond) {
		return nil
	}
	_ = connection.Terminate()
	if connection.waitDone(750 * time.Millisecond) {
		return nil
	}
	killErr := connection.Kill()
	if connection.waitDone(2 * time.Second) {
		return nil
	}
	return errors.Join(killErr, errors.New("connector process did not exit after kill"))
}

func (connection *connectorProcessConnection) CloseInput() error {
	if connection == nil || connection.stdin == nil {
		return nil
	}
	var err error
	connection.inputOnce.Do(func() { err = connection.stdin.Close() })
	return err
}

func (connection *connectorProcessConnection) Terminate() error {
	if connection == nil {
		return nil
	}
	return terminateConnectorProcessGroup(connection.cmd)
}

func (connection *connectorProcessConnection) Kill() error {
	if connection == nil {
		return nil
	}
	connection.cancel()
	return killConnectorProcessGroup(connection.cmd)
}

func (connection *connectorProcessConnection) waitDone(timeout time.Duration) bool {
	if timeout <= 0 {
		select {
		case <-connection.done:
			return true
		default:
			return false
		}
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-connection.done:
		return true
	case <-timer.C:
		return false
	}
}

func (connection *connectorProcessConnection) acceptOutput(stdout bool, size int) error {
	connection.outputMu.Lock()
	defer connection.outputMu.Unlock()
	if stdout {
		connection.stdout += int64(size)
		if connection.stdoutLimit > 0 && connection.stdout > connection.stdoutLimit {
			connection.limitErr = fmt.Errorf("connector process stdout exceeds limit %d", connection.stdoutLimit)
		}
	} else {
		connection.stderr += int64(size)
		if connection.stderrLimit > 0 && connection.stderr > connection.stderrLimit {
			connection.limitErr = fmt.Errorf("connector process stderr exceeds limit %d", connection.stderrLimit)
		}
	}
	return connection.limitErr
}

func (connection *connectorProcessConnection) wait() {
	err := connection.cmd.Wait()
	if connection.preparedExecutable != nil {
		_ = connection.preparedExecutable.Close()
		connection.preparedExecutable = nil
	}
	exitCode := 0
	if err != nil {
		exitCode = 1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
	}
	select {
	case connection.frames <- ProcessFrame{ExitCode: &exitCode}:
	case <-connection.closing:
	}
	close(connection.frames)
	close(connection.done)
}

type connectorFrameWriter struct {
	connection *connectorProcessConnection
	stdout     bool
}

func (writer connectorFrameWriter) Write(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	if err := writer.connection.acceptOutput(writer.stdout, len(data)); err != nil {
		_ = killConnectorProcessGroup(writer.connection.cmd)
		return len(data), nil
	}
	frame := ProcessFrame{}
	if writer.stdout {
		frame.Stdout = append([]byte(nil), data...)
	} else {
		frame.Stderr = append([]byte(nil), data...)
	}
	select {
	case writer.connection.frames <- frame:
		return len(data), nil
	case <-writer.connection.closing:
		return len(data), nil
	}
}

var _ ProcessTransport = connectorProcessTransport{}
var _ GracefulProcessConnection = (*connectorProcessConnection)(nil)
var _ ContextProcessConnection = (*connectorProcessConnection)(nil)
