package agentstatus

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/managednpm"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
	claudecodeservice "github.com/tutti-os/tutti/services/tuttid/service/claudecode"
)

func (s Service) probeCommandWithReadyAfter(
	ctx context.Context,
	result ProbeResult,
	command []string,
	env []string,
	readyAfter time.Duration,
) ProbeResult {
	if ctx == nil {
		ctx = context.Background()
	}
	timeout := s.probeTimeout()
	if readyAfter <= 0 {
		readyAfter = s.probeReadyAfter()
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

func (s Service) probeReadyAfter() time.Duration {
	if s.ProbeReadyAfter > 0 {
		return s.ProbeReadyAfter
	}
	return defaultProbeReadyAfter
}

func (s Service) probeTimeout() time.Duration {
	if s.ProbeTimeout > 0 {
		return s.ProbeTimeout
	}
	return defaultProbeTimeout
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
	cmd.Stdout = installStdoutWriter{buffer: &stdout, onWrite: input.OnStdout}
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

type installStdoutWriter struct {
	buffer  *bytes.Buffer
	onWrite func(string)
}

func (w installStdoutWriter) Write(p []byte) (int, error) {
	if w.buffer != nil {
		_, _ = w.buffer.Write(p)
	}
	if w.onWrite != nil {
		w.onWrite(string(p))
	}
	return len(p), nil
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
	if isClaudeStatusSpec(spec) && strings.TrimSpace(os.Getenv("TUTTI_MOCK_AGENT_UNBOUND")) == "1" {
		return AuthInfo{Status: AuthRequired}
	}
	// A runtime authentication failure (e.g. a 401 sending a message) invalidates
	// the stale "logged in" marker/command result until the user re-authenticates
	// or a request succeeds again. We self-heal the moment the credential file is
	// rewritten by a fresh login: re-login is a terminal action that never reports
	// a "successful run", so without this the flag would stick until the user's
	// next message succeeds, leaving the dock/wizard stuck on "needs login".
	if failedAt, ok := s.RunOutcomes.AuthInvalidatedSince(spec.Provider); ok {
		if !s.authCredentialsRefreshedAfter(spec, failedAt) {
			return AuthInfo{Status: AuthRequired}
		}
		s.RunOutcomes.ClearAuthInvalidated(spec.Provider)
	}
	if len(spec.AuthStatusCommand) > 0 && strings.TrimSpace(binaryPath) != "" {
		if auth, ok := s.resolveAuthFromCommand(ctx, spec, binaryPath); ok {
			return auth
		}
		return s.resolveAuthFromMarkers(spec)
	}
	return s.resolveAuthFromMarkers(spec)
}

// authCredentialsRefreshedAfter reports whether any of the provider's credential
// marker files was modified after the given time — i.e. a login rewrote the
// credentials since the recorded auth failure.
func (s Service) authCredentialsRefreshedAfter(spec ProviderSpec, since time.Time) bool {
	if len(spec.AuthMarkerPaths) == 0 {
		return false
	}
	home, err := s.homeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return false
	}
	for _, marker := range spec.AuthMarkerPaths {
		path := expandHomePath(marker, home)
		if mod, ok := s.fileModTime(path); ok && mod.After(since) {
			return true
		}
	}
	return false
}

func (s Service) resolveAuthFromMarkers(spec ProviderSpec) AuthInfo {
	if len(spec.AuthMarkerPaths) == 0 {
		return AuthInfo{Status: AuthUnknown}
	}

	home, err := s.homeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return AuthInfo{Status: AuthUnknown}
	}

	for _, marker := range spec.AuthMarkerPaths {
		path := expandHomePath(marker, home)
		if auth, ok := s.authFromMarkerFile(spec, path); ok {
			return auth
		}
	}
	return AuthInfo{Status: AuthRequired}
}

func (s Service) authFromMarkerFile(spec ProviderSpec, path string) (AuthInfo, bool) {
	if !s.fileExists(path) {
		return AuthInfo{}, false
	}
	markerParserKind := spec.AuthMarkerParserKind
	if markerParserKind == "" {
		if status, ok := migratedProviderStatus(spec.Provider); ok {
			markerParserKind = status.AuthMarkerParserKind
		}
	}
	switch markerParserKind {
	case providerregistry.AuthMarkerParserKindClaude:
		if auth, ok := parseClaudeAuthMarkerFile(path); ok {
			return auth, true
		}
		return AuthInfo{}, false
	case providerregistry.AuthMarkerParserKindTuttiToken:
		if auth, ok := parseTuttiAgentAuthMarkerFile(path); ok {
			return auth, true
		}
		return AuthInfo{}, false
	case providerregistry.AuthMarkerParserKindFileExists:
		return AuthInfo{Status: AuthAuthenticated}, true
	default:
		return AuthInfo{}, false
	}
}

// parseTuttiAgentAuthMarkerFile validates that the Tutti Agent auth.json holds
// a usable `tutti_llm` token bundle instead of treating file existence as
// authenticated.
func parseTuttiAgentAuthMarkerFile(path string) (AuthInfo, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return AuthInfo{}, false
	}
	var payload struct {
		TuttiLLM *struct {
			AppID        string `json:"app_id"`
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
		} `json:"tutti_llm"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return AuthInfo{}, false
	}
	if payload.TuttiLLM == nil ||
		strings.TrimSpace(payload.TuttiLLM.AccessToken) == "" ||
		strings.TrimSpace(payload.TuttiLLM.RefreshToken) == "" {
		return AuthInfo{Status: AuthRequired}, true
	}
	return AuthInfo{
		AccountLabel: payload.TuttiLLM.AppID,
		AuthMethod:   "tutti_llm",
		Status:       AuthAuthenticated,
	}, true
}

func (s Service) resolveAuthFromCommand(ctx context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
	if ctx == nil {
		ctx = context.Background()
	}
	attempts := authStatusCommandAttempts
	if isCursorAuthCommandSpec(spec) {
		attempts = 1
	}
	for attempt := 0; attempt < attempts; attempt++ {
		if auth, ok := s.runAuthStatusCommand(ctx, spec, binaryPath); ok {
			return auth, true
		}
		if attempt+1 < attempts && !sleepContext(ctx, s.authStatusCommandRetryDelay()) {
			return AuthInfo{}, false
		}
	}
	return AuthInfo{}, false
}

func isCursorAuthCommandSpec(spec ProviderSpec) bool {
	runnerKind := spec.AuthCommandRunnerKind
	if runnerKind == "" {
		if status, ok := migratedProviderStatus(spec.Provider); ok {
			runnerKind = status.AuthCommandRunnerKind
		}
	}
	return runnerKind == providerregistry.AuthCommandRunnerKindCursor
}

func (s Service) runAuthStatusCommand(ctx context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
	if s.RunAuthStatusCommand != nil {
		return s.RunAuthStatusCommand(ctx, spec, binaryPath)
	}
	return runAuthStatusCommand(ctx, spec, binaryPath, s.commandResolver().Env(spec.AdapterEnv))
}

// cliVersionTokenPattern matches the first semver-ish token in `--version`
// output. This is provider-agnostic on purpose: codex prints "codex-cli
// 0.142.1" while claude prints "2.1.191 (Claude Code)" — taking the last
// whitespace field works for the former but yields "Code)" for the latter, so
// we extract the version token instead.
var cliVersionTokenPattern = regexp.MustCompile(`[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+][0-9A-Za-z.-]+)?`)

// parseCLIVersion extracts the version token from `<cli> --version` output.
func parseCLIVersion(output string) string {
	return cliVersionTokenPattern.FindString(strings.TrimSpace(output))
}

// cliVersion runs `<binary> --version` and returns the parsed version token, or
// "" when the binary is absent, errors, or prints nothing version-like. Used for
// every supported provider (not just codex) so the config panel can show the
// installed CLI version.
func (Service) cliVersion(ctx context.Context, binaryPath string, env []string) string {
	return parseCLIVersion(cliVersionOutput(ctx, binaryPath, env))
}

// providerCLIVersion applies the public managed-npm version contract to
// managed package providers. Other providers retain their historical
// semver-ish output compatibility.
func (Service) providerCLIVersion(ctx context.Context, spec ProviderSpec, binaryPath string, env []string) string {
	output := cliVersionOutput(ctx, binaryPath, env)
	if providerUsesManagedNPMVersionContract(spec) {
		version, _ := managednpm.ExtractVersion(output)
		return version
	}
	return parseCLIVersion(output)
}

func cliVersionOutput(ctx context.Context, binaryPath string, env []string) string {
	binaryPath = strings.TrimSpace(binaryPath)
	if binaryPath == "" {
		return ""
	}
	if ctx == nil {
		ctx = context.Background()
	}
	commandCtx, cancel := context.WithTimeout(ctx, authStatusCommandTimeout)
	defer cancel()
	command := exec.CommandContext(commandCtx, binaryPath, "--version")
	if env != nil {
		command.Env = env
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return ""
	}
	return string(output)
}

func cloneProviderChecks(input []ProviderCheck) []ProviderCheck {
	if len(input) == 0 {
		return []ProviderCheck{}
	}
	result := make([]ProviderCheck, len(input))
	copy(result, input)
	return result
}

func cloneProviderLastError(input *ProviderLastError) *ProviderLastError {
	if input == nil {
		return nil
	}
	cloned := *input
	return &cloned
}

func providerLastErrorCode(input *ProviderLastError) string {
	if input == nil {
		return ""
	}
	return input.Code
}

func (s Service) authStatusCommandRetryDelay() time.Duration {
	if s.AuthStatusCommandRetryDelay > 0 {
		return s.AuthStatusCommandRetryDelay
	}
	return defaultAuthStatusCommandRetryDelay
}

func runAuthStatusCommand(ctx context.Context, spec ProviderSpec, binaryPath string, env []string) (AuthInfo, bool) {
	runnerKind := spec.AuthCommandRunnerKind
	if runnerKind == "" {
		if status, ok := migratedProviderStatus(spec.Provider); ok {
			runnerKind = status.AuthCommandRunnerKind
		}
	}
	if runnerKind == providerregistry.AuthCommandRunnerKindCursor {
		return runCursorAuthStatusCommand(ctx, binaryPath, env)
	}
	commandCtx, cancel := context.WithTimeout(ctx, authStatusTimeout(spec))
	defer cancel()
	isClaude := runnerKind == providerregistry.AuthCommandRunnerKindClaudeGate
	if isClaude {
		if err := claudecodeservice.DefaultStartupGate.Acquire(commandCtx); err != nil {
			return AuthInfo{}, false
		}
		defer claudecodeservice.DefaultStartupGate.Release()
	}
	command := exec.CommandContext(commandCtx, binaryPath, spec.AuthStatusCommand...)
	// Inject the macOS system proxy so the auth-status probe reaches the upstream
	// API through the same proxy as spawned agents (mirroring agent install &
	// login), instead of connecting directly and hitting `403 Request not allowed`
	// from a restricted region.
	command.Env = runtimecmd.InjectSystemProxyEnv(env)
	startedAt := time.Now()
	output, err := command.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			output = append(output, exitErr.Stderr...)
		} else {
			if isClaude {
				logClaudeAuthStatusCommandOutput(err, time.Since(startedAt))
			}
			return AuthInfo{}, false
		}
	}
	if isClaude {
		logClaudeAuthStatusCommandOutput(err, time.Since(startedAt))
	}
	return parseAuthStatusCommandOutput(spec.Provider, output)
}

func logClaudeAuthStatusCommandOutput(commandErr error, duration time.Duration) {
	exitStatus := "success"
	if commandErr != nil {
		exitStatus = "failed"
	}
	slog.Info(
		"claude auth status command completed",
		"event", "tutti.agent_provider.claude.auth_status_command.completed",
		"exitStatus", exitStatus,
		"durationMs", duration.Milliseconds(),
	)
}

func authStatusTimeout(spec ProviderSpec) time.Duration {
	if spec.AuthStatusCommandTimeout > 0 {
		return spec.AuthStatusCommandTimeout
	}
	return authStatusCommandTimeout
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
	if auth, ok := parseAuthCommandConfigurationError(output); ok {
		return auth, true
	}
	if status, ok := migratedProviderStatus(provider); ok {
		switch status.AuthOutputParserKind {
		case providerregistry.AuthOutputParserKindCodex:
			return parseCodexAuthStatusOutput(output)
		case providerregistry.AuthOutputParserKindOpenCode:
			return parseOpenCodeAuthStatusOutput(output)
		case providerregistry.AuthOutputParserKindClaude:
			return parseClaudeAuthStatusOutput(output)
		case providerregistry.AuthOutputParserKindCursor:
			return parseCursorAuthStatusOutput(output)
		}
	}
	return AuthInfo{}, false
}

func parseAuthCommandConfigurationError(output []byte) (AuthInfo, bool) {
	normalized := strings.ToLower(string(bytes.TrimSpace(output)))
	if strings.Contains(normalized, "error loading configuration") {
		return AuthInfo{Status: AuthUnknown}, true
	}
	return AuthInfo{}, false
}

func parseCodexAuthStatusOutput(output []byte) (AuthInfo, bool) {
	normalized := strings.ToLower(string(bytes.TrimSpace(output)))
	if normalized == "" {
		return AuthInfo{}, false
	}
	if strings.Contains(normalized, "not logged in") ||
		strings.Contains(normalized, "logged out") {
		return AuthInfo{Status: AuthRequired}, true
	}
	if strings.Contains(normalized, "logged in") {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	return AuthInfo{}, false
}

func parseOpenCodeAuthStatusOutput(output []byte) (AuthInfo, bool) {
	normalized := strings.ToLower(string(bytes.TrimSpace(output)))
	if normalized == "" {
		return AuthInfo{}, false
	}
	if strings.Contains(normalized, "not logged in") ||
		strings.Contains(normalized, "not authenticated") ||
		strings.Contains(normalized, "no authenticated") ||
		strings.Contains(normalized, "no providers") ||
		strings.Contains(normalized, "unauthenticated") {
		return AuthInfo{Status: AuthRequired}, true
	}
	if strings.Contains(normalized, "logged in") ||
		strings.Contains(normalized, "authenticated") {
		return AuthInfo{Status: AuthAuthenticated}, true
	}
	return AuthInfo{}, false
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
				AuthMethod:   payload.AuthMethod,
				Status:       AuthAuthenticated,
			}, true
		}
		return AuthInfo{Status: AuthRequired, AuthMethod: payload.AuthMethod}, true
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

func parseClaudeAuthMarkerFile(path string) (AuthInfo, bool) {
	content, err := os.ReadFile(path)
	if err != nil {
		return AuthInfo{}, false
	}
	return parseClaudeAuthMarkerContent(content)
}

func parseClaudeAuthMarkerContent(content []byte) (AuthInfo, bool) {
	content = bytes.TrimSpace(content)
	if len(content) == 0 {
		return AuthInfo{}, false
	}
	var payload struct {
		AccountLabel string `json:"accountLabel"`
		AuthMethod   string `json:"authMethod"`
		Email        string `json:"email"`
		LoggedIn     *bool  `json:"loggedIn"`
		UserID       string `json:"userID"`
	}
	if err := json.Unmarshal(content, &payload); err != nil {
		return AuthInfo{}, false
	}
	if payload.LoggedIn != nil {
		if *payload.LoggedIn {
			return AuthInfo{
				AccountLabel: firstNonBlank(payload.AccountLabel, payload.Email, payload.AuthMethod, payload.UserID),
				AuthMethod:   payload.AuthMethod,
				Status:       AuthAuthenticated,
			}, true
		}
		return AuthInfo{Status: AuthRequired, AuthMethod: payload.AuthMethod}, true
	}
	if strings.TrimSpace(payload.UserID) != "" {
		return AuthInfo{
			AccountLabel: strings.TrimSpace(payload.UserID),
			Status:       AuthAuthenticated,
		}, true
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

func (s Service) fileModTime(path string) (time.Time, bool) {
	if s.FileModTime != nil {
		return s.FileModTime(path)
	}
	stat, err := os.Stat(path)
	if err != nil || stat.IsDir() {
		return time.Time{}, false
	}
	return stat.ModTime(), true
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
