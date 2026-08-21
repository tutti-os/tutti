package agentstatus

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerstatus"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

const claudeKeychainReadTimeout = 3 * time.Second

func (s Service) resolveRemoteAuthEvidence(
	ctx context.Context,
	spec ProviderSpec,
	binaryPath string,
	env []string,
) (providerstatus.AuthEvidence, bool) {
	if s.RemoteAuthProbe != nil {
		return s.RemoteAuthProbe(ctx, spec)
	}
	if spec.RemoteAuthProbe.Kind == providerregistry.RemoteAuthProbeKindProviderUsage {
		return s.resolveProviderUsageRemoteAuthEvidence(ctx, spec, binaryPath, env)
	}
	token, found, err := s.resolveRemoteAuthCredential(ctx, spec.RemoteAuthProbe.CredentialKind)
	if err != nil {
		slog.Debug("agent provider remote auth credential unavailable",
			"event", "tutti.agent_provider.remote_auth.credential_failed",
			"provider", spec.Provider,
			"error", err,
		)
		return providerstatus.AuthEvidence{
			Kind: providerstatus.AuthEvidenceProbeFailure, Reason: providerstatus.AuthReasonProbeFailed,
		}, true
	}
	if !found {
		return providerstatus.AuthEvidence{}, false
	}
	result := providerstatus.ProbeRemoteAuth(ctx, s.httpClient(), spec.RemoteAuthProbe, token)
	level := slog.LevelDebug
	if result.Evidence.Kind == providerstatus.AuthEvidenceRemoteAuthFailure {
		level = slog.LevelWarn
	}
	slog.Log(ctx, level, "agent provider remote auth probe completed",
		"event", "tutti.agent_provider.remote_auth.completed",
		"provider", spec.Provider,
		"evidence", result.Evidence.Kind,
		"statusCode", result.StatusCode,
		"success", result.Evidence.Kind == providerstatus.AuthEvidenceRemoteSuccess,
	)
	return result.Evidence, true
}

func (s Service) resolveProviderUsageRemoteAuthEvidence(
	ctx context.Context,
	spec ProviderSpec,
	binaryPath string,
	env []string,
) (providerstatus.AuthEvidence, bool) {
	if authCommandRunnerKind(spec) != providerregistry.AuthCommandRunnerKindCodexAppServerAccount ||
		strings.TrimSpace(binaryPath) == "" {
		return providerstatus.AuthEvidence{
			Kind: providerstatus.AuthEvidenceProbeFailure, Reason: providerstatus.AuthReasonProbeFailed,
		}, true
	}
	command := append([]string{binaryPath}, spec.AuthStatusCommand...)
	if s.CodexRemoteAuthProbe != nil {
		return s.CodexRemoteAuthProbe(ctx, command, append([]string(nil), env...)), true
	}
	release, acquired := s.DetectionCommands.acquire(ctx)
	if !acquired {
		return providerstatus.AuthEvidence{
			Kind: providerstatus.AuthEvidenceProbeFailure, Reason: providerstatus.AuthReasonProbeFailed,
		}, true
	}
	defer release()
	timeout := time.Duration(spec.RemoteAuthProbe.TimeoutSeconds) * time.Second
	result := agentruntime.ProbeCodexAppServer(ctx, agentruntime.CodexAppServerProbeInput{
		Command: command,
		Env:     append([]string(nil), env...),
		Host: agentruntime.HostMetadata{ClientInfo: agentruntime.ClientInfo{
			Name: "tutti-desktop", Title: "Tutti", Version: "0.1.0",
		}},
		ReadAccount:      true,
		ReadRateLimits:   true,
		StartupTimeout:   timeout,
		HandshakeTimeout: timeout,
		ShutdownTimeout:  s.probeReadyAfter(),
	})
	var evidence providerstatus.AuthEvidence
	switch result.AccountState {
	case agentruntime.CodexAppServerAccountRequired:
		evidence = providerstatus.AuthEvidence{Kind: providerstatus.AuthEvidenceRemoteAuthFailure, Reason: providerstatus.AuthReasonAuthRequired}
	case agentruntime.CodexAppServerAccountAuthenticated:
		evidence = providerstatus.AuthEvidence{Kind: providerstatus.AuthEvidenceRemoteSuccess}
	default:
		evidence = providerstatus.AuthEvidence{Kind: providerstatus.AuthEvidenceProbeFailure, Reason: providerstatus.AuthReasonProbeFailed}
	}
	level := slog.LevelDebug
	if evidence.Kind == providerstatus.AuthEvidenceRemoteAuthFailure {
		level = slog.LevelWarn
	}
	slog.Log(ctx, level, "agent provider remote auth probe completed",
		"event", "tutti.agent_provider.remote_auth.completed",
		"provider", spec.Provider,
		"evidence", evidence.Kind,
		"success", evidence.Kind == providerstatus.AuthEvidenceRemoteSuccess,
	)
	return evidence, true
}

func (s Service) resolveRemoteAuthCredential(
	ctx context.Context,
	kind providerregistry.RemoteAuthCredentialKind,
) (string, bool, error) {
	switch kind {
	case providerregistry.RemoteAuthCredentialKindClaudeOAuth:
		return s.resolveClaudeOAuthAccessToken(ctx)
	default:
		return "", false, fmt.Errorf("remote auth credential kind %q is unsupported", kind)
	}
}

func (s Service) resolveClaudeOAuthAccessToken(ctx context.Context) (string, bool, error) {
	configDir := strings.TrimSpace(s.lookupEnv("CLAUDE_CONFIG_DIR"))
	if configDir == "" {
		home, err := s.homeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			return "", false, err
		}
		configDir = filepath.Join(home, ".claude")
	}
	var keychainErr error
	if runtime.GOOS == "darwin" {
		for _, service := range providerstatus.ClaudeOAuthKeychainServices(configDir) {
			content, err := readClaudeKeychainCredential(ctx, service)
			if err != nil {
				keychainErr = err
				continue
			}
			if token, ok := providerstatus.ClaudeOAuthAccessToken(content); ok {
				return token, true, nil
			}
		}
	}
	content, err := os.ReadFile(filepath.Join(configDir, ".credentials.json"))
	if err == nil {
		if token, ok := providerstatus.ClaudeOAuthAccessToken(content); ok {
			return token, true, nil
		}
		return "", false, fmt.Errorf("claude OAuth credentials do not contain an access token")
	}
	if !os.IsNotExist(err) {
		return "", false, fmt.Errorf("read Claude OAuth credentials: %w", err)
	}
	if keychainErr != nil {
		return "", false, keychainErr
	}
	return "", false, nil
}

func readClaudeKeychainCredential(ctx context.Context, service string) ([]byte, error) {
	readCtx, cancel := context.WithTimeout(ctx, claudeKeychainReadTimeout)
	defer cancel()
	output, err := exec.CommandContext(
		readCtx,
		"/usr/bin/security",
		"find-generic-password",
		"-s",
		service,
		"-w",
	).Output()
	if err != nil {
		return nil, fmt.Errorf("read Claude Keychain service %q: %w", service, err)
	}
	if len(strings.TrimSpace(string(output))) == 0 {
		return nil, fmt.Errorf("claude Keychain service %q is empty", service)
	}
	return output, nil
}
