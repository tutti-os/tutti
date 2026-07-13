package agentstatus

import (
	"runtime"
	"strings"

	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

func (s Service) codexPlatformBinaryOK(binaryPath string) bool {
	pkgDir := codexPackageDirForBinary(binaryPath)
	if pkgDir == "" {
		return true
	}
	_, ok := s.codexPlatformBinaryComplete(pkgDir, runtime.GOOS, runtime.GOARCH)
	return ok
}

func codexProviderChecks(status ProviderStatus, platformBinaryOK bool, nodeRuntime ProviderCheck) []ProviderCheck {
	return []ProviderCheck{
		{
			Name:   "cli_present",
			Passed: status.CLI.Installed,
			Detail: firstNonBlank(status.CLI.BinaryPath, "CLI binary not found"),
		},
		{
			Name:   "platform_binary",
			Passed: platformBinaryOK,
			Detail: codexPlatformBinaryDetail(status.CLI.BinaryPath, platformBinaryOK),
		},
		{
			Name:   "version_floor",
			Passed: cliVersionMeetsMinimum(status.CLI.Version, status.CLI.MinVersion),
			Detail: firstNonBlank(status.CLI.Version, "version unknown"),
		},
		nodeRuntime,
		{
			Name:   "auth",
			Passed: status.Auth.Status == AuthAuthenticated,
			Detail: providerAvailabilityAuthDetailForStatus(status.Auth),
		},
	}
}

func (s Service) codexNodeRuntimeCheck(spec ProviderSpec) ProviderCheck {
	if nodePath := strings.TrimSpace(managedruntime.EnvValue(spec.AdapterEnv, "TUTTI_APP_NODE")); nodePath != "" {
		return ProviderCheck{
			Name:   "node_runtime",
			Passed: true,
			Detail: "Using Tutti managed Node fallback: " + nodePath,
		}
	}
	if resolved := s.userNodeRuntimePath(spec.AdapterEnv); resolved != "" {
		return ProviderCheck{
			Name:   "node_runtime",
			Passed: true,
			Detail: "Using user Node from PATH: " + resolved,
		}
	}
	return ProviderCheck{
		Name:   "node_runtime",
		Passed: false,
		Detail: "Node runtime not found",
	}
}

func codexProviderLastError(status ProviderStatus) *ProviderLastError {
	switch strings.TrimSpace(status.Availability.ReasonCode) {
	case "cli_not_found":
		return &ProviderLastError{Code: string(CodexErrCLIMissing), Message: "CLI binary not found"}
	case "codex_platform_pkg_incomplete":
		return &ProviderLastError{Code: string(CodexErrPlatformPkgIncomplete), Message: "Codex platform package is incomplete"}
	case "codex_version_too_old":
		return &ProviderLastError{Code: string(CodexErrVersionTooOld), Message: "Codex CLI version is below " + status.CLI.MinVersion}
	case "auth_required", "auth_unknown":
		return &ProviderLastError{Code: string(CodexErrAuthRequired), Message: "authentication required"}
	default:
		return nil
	}
}

func codexReasonCodeFromErrorCode(code string) string {
	switch CodexErrorCode(code) {
	case CodexErrCLIMissing:
		return "cli_not_found"
	case CodexErrPlatformPkgIncomplete:
		return "codex_platform_pkg_incomplete"
	case CodexErrVersionTooOld:
		return "codex_version_too_old"
	case CodexErrAuthRequired:
		return "auth_required"
	case CodexErrNetwork:
		return "network_error"
	default:
		return "codex_runtime_error"
	}
}

func codexPlatformBinaryDetail(binaryPath string, ok bool) string {
	if ok {
		return firstNonBlank(binaryPath, "platform binary available")
	}
	return "Codex platform package is incomplete"
}

func providerAvailabilityAuthDetailForStatus(auth AuthInfo) string {
	switch auth.Status {
	case AuthAuthenticated:
		return firstNonBlank(auth.AccountLabel, "authenticated")
	case AuthRequired:
		return "authentication required"
	default:
		return "authentication unknown"
	}
}
