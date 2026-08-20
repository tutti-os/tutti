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
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/managednpm"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerstatus"
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
	cmd := newInstallExecCommand(probeCtx, command[0], command[1:]...)
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
	var cmd *exec.Cmd
	if len(input.Args) > 0 {
		program := strings.TrimSpace(input.Args[0])
		if program == "" {
			return InstallCommandResult{ExitCode: 1}, errors.New("installer program is empty")
		}
		cmd = newInstallExecCommand(ctx, program, input.Args[1:]...)
	} else {
		command := strings.TrimSpace(input.Command)
		if command == "" {
			return InstallCommandResult{ExitCode: 1}, errors.New("installer command is empty")
		}
		cmd = newInstallShellCommand(ctx, command)
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

func (s Service) resolveAuth(ctx context.Context, spec ProviderSpec, installed bool, binaryPath string) AuthInfo {
	auth, _, _ := s.resolveAuthAndCLIVersion(ctx, spec, installed, binaryPath)
	return auth
}

func (s Service) resolveAuthAndCLIVersion(
	ctx context.Context,
	spec ProviderSpec,
	installed bool,
	binaryPath string,
) (AuthInfo, string, providerstatus.AuthEvidenceAuthority) {
	if !installed {
		return AuthInfo{Status: AuthUnknown}, "", providerstatus.AuthEvidenceAuthorityNone
	}
	if isClaudeStatusSpec(spec) && strings.TrimSpace(os.Getenv("TUTTI_MOCK_AGENT_UNBOUND")) == "1" {
		return AuthInfo{Status: AuthRequired}, "", providerstatus.AuthEvidenceAuthorityLocal
	}
	// RunAuthStatusCommand is an explicit test seam. Keep it authoritative so
	// status-cache tests can observe detection without depending on a real home
	// directory or provider credential file.
	if s.RunAuthStatusCommand != nil && len(spec.AuthStatusCommand) > 0 &&
		strings.TrimSpace(binaryPath) != "" {
		if auth, ok := s.resolveAuthFromCommand(ctx, spec, binaryPath); ok {
			return auth, "", authCommandEvidenceAuthority(spec)
		}
		return s.resolveAuthFromMarkers(spec), "", providerstatus.AuthEvidenceAuthorityLocal
	}
	if authMarkerIsAuthoritative(spec) {
		if auth, definitive := s.resolveAuthFromMarkersWithValidity(spec); definitive {
			return auth, "", providerstatus.AuthEvidenceAuthorityLocal
		}
	}
	if len(spec.AuthStatusCommand) > 0 && strings.TrimSpace(binaryPath) != "" {
		if isCursorAuthCommandSpec(spec) && s.RunAuthStatusCommand == nil {
			release, acquired := s.DetectionCommands.acquire(ctx)
			if !acquired {
				return s.resolveAuthFromMarkers(spec), "", providerstatus.AuthEvidenceAuthorityLocal
			}
			defer release()
			auth, cliVersion, ok := s.cursorAuthStatus(
				ctx,
				binaryPath,
				s.commandResolver().Env(spec.AdapterEnv),
			)
			if ok {
				return auth, cliVersion, providerstatus.AuthEvidenceAuthorityLocal
			}
			return s.resolveAuthFromMarkers(spec), cliVersion, providerstatus.AuthEvidenceAuthorityLocal
		}
		if auth, ok := s.resolveAuthFromCommand(ctx, spec, binaryPath); ok {
			return auth, "", authCommandEvidenceAuthority(spec)
		}
		return s.resolveAuthFromMarkers(spec), "", providerstatus.AuthEvidenceAuthorityLocal
	}
	return s.resolveAuthFromMarkers(spec), "", providerstatus.AuthEvidenceAuthorityLocal
}

func authCommandEvidenceAuthority(ProviderSpec) providerstatus.AuthEvidenceAuthority {
	return providerstatus.AuthEvidenceAuthorityLocal
}

func (s Service) reduceProviderAuth(
	spec ProviderSpec,
	local AuthInfo,
	hasAPICredential bool,
	authority providerstatus.AuthEvidenceAuthority,
) AuthInfo {
	return s.reduceProviderAuthWithRemote(spec, local, hasAPICredential, authority, providerstatus.AuthEvidence{}, false)
}

func (s Service) reduceProviderAuthWithRemote(
	spec ProviderSpec,
	local AuthInfo,
	hasAPICredential bool,
	authority providerstatus.AuthEvidenceAuthority,
	remote providerstatus.AuthEvidence,
	hasRemoteEvidence bool,
) AuthInfo {
	evidence := providerstatus.LocalAuthEvidence(local)
	if hasAPICredential {
		evidence.Kind = providerstatus.AuthEvidenceLocalCredential
	} else if authority == providerstatus.AuthEvidenceAuthorityRemote {
		switch local.Status {
		case AuthAuthenticated:
			evidence.Kind = providerstatus.AuthEvidenceRemoteSuccess
		case AuthRequired:
			evidence.Kind = providerstatus.AuthEvidenceRemoteAuthFailure
		}
	}
	observation := providerstatus.ReduceAuthEvidence(providerstatus.AuthObservation{}, evidence)
	if hasRemoteEvidence {
		if strings.TrimSpace(remote.AccountLabel) == "" {
			remote.AccountLabel = observation.AccountLabel
		}
		if strings.TrimSpace(remote.AuthMethod) == "" {
			remote.AuthMethod = observation.AuthMethod
		}
		observation = providerstatus.ReduceAuthEvidence(observation, remote)
	}
	remoteEvidence, observedAt, ok := s.RunOutcomes.AuthEvidence(spec.Provider)
	if ok && s.authCredentialsRefreshedAfter(spec, observedAt) {
		s.RunOutcomes.ClearAuthEvidence(spec.Provider)
		ok = false
	}
	if ok {
		if strings.TrimSpace(remoteEvidence.AccountLabel) == "" {
			remoteEvidence.AccountLabel = observation.AccountLabel
		}
		if strings.TrimSpace(remoteEvidence.AuthMethod) == "" {
			remoteEvidence.AuthMethod = observation.AuthMethod
		}
		observation = providerstatus.ReduceAuthEvidence(observation, remoteEvidence)
	}
	return providerstatus.AuthInfoFromObservation(observation)
}

func (s Service) cursorAuthStatus(
	ctx context.Context,
	binaryPath string,
	env []string,
) (AuthInfo, string, bool) {
	if s.runCursorAuthStatusCommand != nil {
		return s.runCursorAuthStatusCommand(ctx, binaryPath, env)
	}
	return runCursorAuthStatusCommand(ctx, binaryPath, env)
}

func (s Service) resolveAuthFromCommand(ctx context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
	if ctx == nil {
		ctx = context.Background()
	}
	attempts := authStatusCommandAttempts
	if isCursorAuthCommandSpec(spec) ||
		authMarkerIsAuthoritative(spec) {
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
	return authCommandRunnerKind(spec) == providerregistry.AuthCommandRunnerKindCursor
}

func authCommandRunnerKind(spec ProviderSpec) providerregistry.AuthCommandRunnerKind {
	if spec.AuthCommandRunnerKind != "" {
		return spec.AuthCommandRunnerKind
	}
	if status, ok := migratedProviderStatus(spec.Provider); ok {
		return status.AuthCommandRunnerKind
	}
	return ""
}

func (s Service) runAuthStatusCommand(ctx context.Context, spec ProviderSpec, binaryPath string) (AuthInfo, bool) {
	if s.RunAuthStatusCommand != nil {
		return s.RunAuthStatusCommand(ctx, spec, binaryPath)
	}
	release, acquired := s.DetectionCommands.acquire(ctx)
	if !acquired {
		return AuthInfo{}, false
	}
	defer release()
	env := s.commandResolver().Env(spec.AdapterEnv)
	if authCommandRunnerKind(spec) == providerregistry.AuthCommandRunnerKindCodexAppServerAccount {
		command := append([]string{binaryPath}, spec.AuthStatusCommand...)
		evidence := s.probeCodexAuth(ctx, command, env, authStatusTimeout(spec))
		// account/read is the canonical authentication check used by Codex
		// startup. Even a failed probe is authoritative as "unknown": falling
		// back to auth.json file existence would recreate the false positive.
		return authInfoFromCodexProbe(evidence), true
	}
	return runAuthStatusCommand(ctx, spec, binaryPath, env)
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
func (s Service) cliVersion(ctx context.Context, binaryPath string, env []string) string {
	return parseCLIVersion(s.cliVersionOutput(ctx, binaryPath, env))
}

// providerCLIVersion applies the public managed-npm version contract to
// managed package providers. Other providers retain their historical
// semver-ish output compatibility.
func (s Service) providerCLIVersion(ctx context.Context, spec ProviderSpec, binaryPath string, env []string) string {
	output := s.cliVersionOutput(ctx, binaryPath, env)
	if providerUsesManagedNPMVersionContract(spec) {
		version, _ := managednpm.ExtractVersion(output)
		return version
	}
	return parseCLIVersion(output)
}

func (s Service) cliVersionOutput(ctx context.Context, binaryPath string, env []string) string {
	binaryPath = strings.TrimSpace(binaryPath)
	if binaryPath == "" {
		return ""
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return s.CLIVersionCache.load(binaryPath, func() string {
		release, acquired := s.DetectionCommands.acquire(ctx)
		if !acquired {
			return ""
		}
		defer release()
		commandCtx, cancel := context.WithTimeout(ctx, authStatusCommandTimeout)
		defer cancel()
		command := newInstallExecCommand(commandCtx, binaryPath, "--version")
		if env != nil {
			command.Env = env
		}
		output, err := command.CombinedOutput()
		if err != nil {
			return ""
		}
		return string(output)
	})
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
	runnerKind := authCommandRunnerKind(spec)
	if runnerKind == providerregistry.AuthCommandRunnerKindCursor {
		auth, _, ok := runCursorAuthStatusCommand(ctx, binaryPath, env)
		return auth, ok
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
	command := newInstallExecCommand(commandCtx, binaryPath, spec.AuthStatusCommand...)
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
	parserKind := spec.AuthOutputParserKind
	if parserKind == "" {
		if status, ok := migratedProviderStatus(spec.Provider); ok {
			parserKind = status.AuthOutputParserKind
		}
	}
	return providerstatus.ParseAuthStatusOutput(parserKind, output)
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
	return platformExecutableFile(stat)
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
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		return filepath.Join(home, path[2:])
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
	return joinLoginShellCommand(parts)
}
