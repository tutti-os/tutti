package agentstatus

import (
	"context"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

const codexColdStartProbeTimeout = 10 * time.Second

func (s Service) codexProbeTimeout() time.Duration {
	timeout := s.probeTimeout()
	if timeout < codexColdStartProbeTimeout {
		return codexColdStartProbeTimeout
	}
	return timeout
}

func (s Service) probeCodexAppServer(ctx context.Context, command, env []string) CodexProbeEvidence {
	if s.CodexProtocolProbe != nil {
		return s.CodexProtocolProbe(ctx, append([]string(nil), command...), append([]string(nil), env...))
	}
	result := agentruntime.ProbeCodexAppServer(ctx, agentruntime.CodexAppServerProbeInput{
		Command: command,
		Env:     env,
		Host: agentruntime.HostMetadata{ClientInfo: agentruntime.ClientInfo{
			Name: "tutti-desktop", Title: "Tutti", Version: "0.1.0",
		}},
		StartupTimeout: s.codexProbeTimeout(), HandshakeTimeout: s.codexProbeTimeout(), ShutdownTimeout: s.probeReadyAfter(),
	})
	diagnosticMessage := joinCodexProbeMessages(result.Message, result.StderrTail)
	commandCategory, commandPackage := codexProbeClassification(result.CommandCategory, diagnosticMessage)
	protocolCategory, protocolPackage := codexProbeClassification(result.ProtocolCategory, diagnosticMessage)
	category, platformPackage := protocolCategory, protocolPackage
	if !result.CommandStarted {
		category, platformPackage = commandCategory, commandPackage
	}
	if category == "" {
		category, platformPackage = codexProbeClassification(result.Category, diagnosticMessage)
	}
	return CodexProbeEvidence{
		CommandStarted:      result.CommandStarted,
		ProtocolReady:       result.ProtocolReady,
		Category:            category,
		PlatformPackageName: platformPackage,
		Message:             truncateCodexProbeMessage(diagnosticMessage),
	}
}

func codexProbeClassification(category, message string) (string, string) {
	lower := strings.ToLower(message)
	if (strings.Contains(lower, "unknown command") || strings.Contains(lower, "unrecognized subcommand")) &&
		strings.Contains(lower, "app-server") {
		return "app_server_unsupported", ""
	}
	platform, ok := codexNpmPlatformDir(runtime.GOOS, runtime.GOARCH)
	if ok {
		needle := "@openai/" + platform
		missingPlatformDependency := strings.Contains(lower, "enoent") ||
			strings.Contains(lower, "missing optional dependency") ||
			strings.Contains(lower, "cannot find module") ||
			strings.Contains(lower, "could not find module")
		if missingPlatformDependency && strings.Contains(lower, strings.ToLower(needle)) {
			return "platform_package_enoent", needle
		}
	}
	return category, ""
}

func joinCodexProbeMessages(messages ...string) string {
	joined := make([]string, 0, len(messages))
	seen := map[string]struct{}{}
	for _, message := range messages {
		message = strings.TrimSpace(message)
		if message == "" {
			continue
		}
		if _, ok := seen[message]; ok {
			continue
		}
		seen[message] = struct{}{}
		joined = append(joined, message)
	}
	return strings.Join(joined, "\n")
}

func truncateCodexProbeMessage(message string) string {
	const limit = 1024
	message = strings.TrimSpace(message)
	if len(message) <= limit {
		return message
	}
	for len(message) > limit {
		message = message[:limit]
		for len(message) > 0 && !utf8.ValidString(message) {
			message = message[:len(message)-1]
		}
	}
	return message + " [truncated]"
}
