package agentstatus

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/runtimecmd"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func (s Service) probeCommand(ctx context.Context, result ProbeResult, command []string, env []string) ProbeResult {
	if ctx == nil {
		ctx = context.Background()
	}
	timeout := s.ProbeTimeout
	if timeout <= 0 {
		timeout = defaultProbeTimeout
	}
	readyAfter := s.ProbeReadyAfter
	if readyAfter <= 0 {
		readyAfter = defaultProbeReadyAfter
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd := exec.CommandContext(probeCtx, command[0], command[1:]...)
	cmd.Env = env
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.WaitDelay = defaultProbeWaitDelay
	if err := cmd.Start(); err != nil {
		result.Status = ProbeFailed
		result.ReasonCode = "probe_start_failed"
		result.Message = err.Error()
		return result
	}

	waitCh := make(chan error, 1)
	go func() {
		waitCh <- cmd.Wait()
	}()

	select {
	case err := <-waitCh:
		return finishProbeWaitResult(result, err, stdout.String(), stderr.String())
	case <-time.After(readyAfter):
		select {
		case err := <-waitCh:
			return finishProbeWaitResult(result, err, stdout.String(), stderr.String())
		default:
		}
		cancel()
		<-waitCh
		result.Status = ProbeReady
		return result
	case <-probeCtx.Done():
		<-waitCh
		if errors.Is(ctx.Err(), context.Canceled) {
			result.Status = ProbeFailed
			result.ReasonCode = "probe_canceled"
			result.Message = ctx.Err().Error()
			return result
		}
		result.Status = ProbeFailed
		result.ReasonCode = "probe_timed_out"
		result.Message = probeCtx.Err().Error()
		return result
	}
}

func finishProbeWaitResult(result ProbeResult, err error, stdout string, stderr string) ProbeResult {
	if err != nil {
		result.Status = ProbeFailed
		result.ReasonCode = "probe_exited"
		result.Message = firstNonBlank(trimProbeOutput(stderr), trimProbeOutput(stdout), err.Error())
		return result
	}
	result.Status = ProbeReady
	return result
}

func (s Service) installCommand(ctx context.Context, input InstallCommandInput) (InstallCommandResult, error) {
	if s.InstallCommand != nil {
		return s.InstallCommand(ctx, input)
	}
	return runDefaultInstallCommand(ctx, input)
}

func (s Service) installTimeout() time.Duration {
	if s.InstallTimeout > 0 {
		return s.InstallTimeout
	}
	return defaultInstallTimeout
}

func runDefaultInstallCommand(ctx context.Context, input InstallCommandInput) (InstallCommandResult, error) {
	ctx = baseContext(ctx)
	command := strings.TrimSpace(input.Command)
	if command == "" {
		return InstallCommandResult{ExitCode: 1}, errors.New("installer command is empty")
	}

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, resolveInstallerShell(), "/C", command)
	} else {
		cmd = exec.CommandContext(ctx, resolveInstallerShell(), "-lc", command)
	}
	cmd.Dir = strings.TrimSpace(input.CWD)
	cmd.Env = input.Env
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	result := InstallCommandResult{
		ExitCode: 0,
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
	}
	if err == nil {
		return result, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		result.ExitCode = exitErr.ExitCode()
		return result, nil
	}
	result.ExitCode = 1
	return result, err
}

func baseContext(ctx context.Context) context.Context {
	if ctx != nil {
		return ctx
	}
	return context.Background()
}

func resolveInstallerShell() string {
	if runtime.GOOS == "windows" {
		if shell := strings.TrimSpace(os.Getenv("ComSpec")); shell != "" {
			return shell
		}
		return "cmd.exe"
	}
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell
	}
	return "/bin/zsh"
}

func (s Service) resolveAuth(ctx context.Context, spec ProviderSpec, installed bool, binaryPath string) AuthInfo {
	if !installed {
		return AuthInfo{Status: AuthUnknown}
	}
	if spec.Provider == agentprovider.ClaudeCode && strings.TrimSpace(os.Getenv("TUTTI_MOCK_AGENT_UNBOUND")) == "1" {
		return AuthInfo{Status: AuthRequired}
	}
	if len(spec.AuthStatusCommand) > 0 && strings.TrimSpace(binaryPath) != "" {
		if auth, ok := s.resolveAuthFromCommand(ctx, spec, binaryPath); ok {
			return auth
		}
		return AuthInfo{Status: AuthUnknown}
	}
	if len(spec.AuthMarkerPaths) == 0 {
		return AuthInfo{Status: AuthUnknown}
	}

	home, err := s.homeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return AuthInfo{Status: AuthUnknown}
	}

	for _, marker := range spec.AuthMarkerPaths {
		path := expandHomePath(marker, home)
		if s.fileExists(path) {
			return AuthInfo{Status: AuthAuthenticated}
		}
	}
	return AuthInfo{Status: AuthRequired}
}

func (s Service) resolveAuthFromCommand(ctx context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
	if ctx == nil {
		ctx = context.Background()
	}
	for attempt := 0; attempt < authStatusCommandAttempts; attempt++ {
		if auth, ok := s.runAuthStatusCommand(ctx, spec, binaryPath); ok {
			return auth, true
		}
		if attempt+1 < authStatusCommandAttempts && !sleepContext(ctx, s.authStatusCommandRetryDelay()) {
			return AuthInfo{}, false
		}
	}
	return AuthInfo{}, false
}

func (s Service) runAuthStatusCommand(ctx context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
	if s.RunAuthStatusCommand != nil {
		return s.RunAuthStatusCommand(ctx, spec, binaryPath)
	}
	return runAuthStatusCommand(ctx, spec, binaryPath)
}

func (s Service) authStatusCommandRetryDelay() time.Duration {
	if s.AuthStatusCommandRetryDelay > 0 {
		return s.AuthStatusCommandRetryDelay
	}
	return defaultAuthStatusCommandRetryDelay
}

func runAuthStatusCommand(ctx context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
	commandCtx, cancel := context.WithTimeout(ctx, authStatusCommandTimeout)
	defer cancel()
	command := exec.CommandContext(commandCtx, binaryPath, spec.AuthStatusCommand...)
	output, err := command.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			output = append(output, exitErr.Stderr...)
		} else {
			return AuthInfo{}, false
		}
	}
	return parseAuthStatusCommandOutput(spec.Provider, output)
}

func sleepContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func parseAuthStatusCommandOutput(provider string, output []byte) (AuthInfo, bool) {
	switch agentprovider.Normalize(provider) {
	case agentprovider.ClaudeCode:
		return parseClaudeAuthStatusOutput(output)
	default:
		return AuthInfo{}, false
	}
}

func parseClaudeAuthStatusOutput(output []byte) (AuthInfo, bool) {
	output = bytes.TrimSpace(output)
	if len(output) == 0 {
		return AuthInfo{}, false
	}
	var payload struct {
		AccountLabel string `json:"accountLabel"`
		AuthMethod   string `json:"authMethod"`
		Email        string `json:"email"`
		LoggedIn     *bool  `json:"loggedIn"`
	}
	if err := json.Unmarshal(output, &payload); err == nil && payload.LoggedIn != nil {
		if *payload.LoggedIn {
			return AuthInfo{
				AccountLabel: firstNonBlank(payload.AccountLabel, payload.Email, payload.AuthMethod),
				Status:       AuthAuthenticated,
			}, true
		}
		return AuthInfo{Status: AuthRequired}, true
	}
	normalized := strings.ToLower(string(output))
	if strings.Contains(normalized, `"loggedin":false`) ||
		strings.Contains(normalized, "not logged in") ||
		strings.Contains(normalized, "logged out") {
		return AuthInfo{Status: AuthRequired}, true
	}
	if strings.Contains(normalized, `"loggedin":true`) ||
		strings.Contains(normalized, "logged in") {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	return AuthInfo{}, false
}

func daemonAction(id ActionID) Action {
	return Action{ID: id, Kind: ActionKindDaemonAction}
}

func terminalAction(id ActionID, command string) Action {
	command = strings.TrimSpace(command)
	if command == "" {
		return Action{ID: id, Kind: ActionKindRefresh}
	}
	return Action{
		ID:   id,
		Kind: ActionKindTerminalCommand,
		Command: &TerminalCommand{
			Input: commandWithNewline(command),
		},
	}
}

func commandWithNewline(command string) string {
	command = strings.TrimRight(command, "\r\n")
	if command == "" {
		return ""
	}
	return command + "\n"
}

func trimProbeOutput(value string) string {
	trimmed := strings.TrimSpace(value)
	return trimmed[:min(len(trimmed), 1000)]
}

func trimActionOutput(value string) string {
	trimmed := strings.TrimSpace(value)
	return trimmed[:min(len(trimmed), 4000)]
}

func intPointer(value int) *int {
	return &value
}

func (s Service) fileExists(path string) bool {
	if s.FileExists != nil {
		return s.FileExists(path)
	}
	stat, err := os.Stat(path)
	return err == nil && !stat.IsDir()
}

func (s Service) executableFile(path string) bool {
	if s.IsExecutableFile != nil {
		return s.IsExecutableFile(path)
	}
	stat, err := os.Stat(path)
	if err != nil || stat.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return stat.Mode().Perm()&0o111 != 0
}

func (s Service) homeDir() (string, error) {
	if s.HomeDir != nil {
		return s.HomeDir()
	}
	return os.UserHomeDir()
}

func (s Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

func (s Service) commandResolver() runtimecmd.Resolver {
	return runtimecmd.Resolver{
		Environ:          s.Environ,
		HomeDir:          s.HomeDir,
		IsExecutableFile: s.IsExecutableFile,
		LookPath:         s.LookPath,
	}
}

func (s Service) registry() Registry {
	if len(s.Registry.Specs) > 0 {
		return s.Registry
	}
	return DefaultRegistry()
}

func expandHomePath(path string, home string) string {
	path = strings.TrimSpace(path)
	if path == "~" {
		return home
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(home, strings.TrimPrefix(path, "~/"))
	}
	return path
}

var ErrInvalidProvider = errors.New("invalid agent provider")
var ErrInvalidAction = errors.New("invalid agent provider action")

func cloneStrings(input []string) []string {
	if len(input) == 0 {
		return []string{}
	}
	result := make([]string, len(input))
	copy(result, input)
	return result
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func loginCommandForRuntime(spec ProviderSpec, runtime providerRuntimeResolution) string {
	if len(spec.LoginArgs) == 0 {
		return ""
	}
	command := firstNonBlank(runtime.CLIPath, firstNonBlank(spec.BinaryNames...))
	if strings.TrimSpace(command) == "" {
		return ""
	}
	parts := append([]string{command}, spec.LoginArgs...)
	return joinShellCommand(parts)
}
