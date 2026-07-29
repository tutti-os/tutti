package agentstatus

import "strings"

type CodexPathPresence string

const (
	CodexPathPresent       CodexPathPresence = "present"
	CodexPathMissing       CodexPathPresence = "missing"
	CodexPathUnknown       CodexPathPresence = "unknown"
	CodexPathInaccessible  CodexPathPresence = "inaccessible"
	CodexPathNotApplicable CodexPathPresence = "not_applicable"
)

// CodexPackageLayoutEvidence records only scanner facts. It stays private to
// agentstatus and is consulted only after a failed platform-package probe.
type CodexPackageLayoutEvidence struct {
	LayoutType                 string
	PackageManager             string
	PackageRoot                string
	PlatformPackageName        string
	PlatformPackagePath        string
	ExpectedPlatformBinaryPath string
	PlatformPackagePresence    CodexPathPresence
	PlatformBinaryPresence     CodexPathPresence
	PlatformBinaryExists       bool
	PlatformBinaryExecutable   bool
	PlatformBinaryDetailCode   string
}

type CodexProbeEvidence struct {
	CommandStarted      bool
	ProtocolReady       bool
	Category            string
	Message             string
	PlatformPackageName string
}

// CodexRepairPlan is intentionally small: it is only the authorization passed
// to the installer after a fresh failed app-server probe.
type CodexRepairPlan struct {
	Allowed    bool
	ReasonCode string
}

type codexRuntimeAssessment struct {
	RuntimeReady bool
	ReasonCode   string
	RepairPlan   CodexRepairPlan
}

func (s Service) assessCodexRuntime(spec ProviderSpec, binaryPath string, probe ProbeResult, probeRan, probeCacheHit bool) codexRuntimeAssessment {
	if probeCacheHit || (probeRan && probe.ProtocolReady) {
		return codexRuntimeAssessment{RuntimeReady: true}
	}
	if !probeRan {
		return codexRuntimeAssessment{ReasonCode: "acp_adapter_not_found"}
	}
	category := firstNonBlank(probe.ProtocolCategory, probe.CommandCategory)
	if category == "app_server_unsupported" {
		return codexRuntimeAssessment{ReasonCode: "app_server_unsupported"}
	}
	assessment := codexRuntimeAssessment{ReasonCode: firstNonBlank(probe.ReasonCode, "acp_adapter_launch_failed")}
	if category != "platform_package_enoent" || strings.TrimSpace(probe.ProtocolPackageName) == "" {
		return assessment
	}
	layout := s.scanCodexPackageLayout(binaryPath)
	if spec.resolvedCLIManager != "" {
		layout.PackageManager = spec.resolvedCLIManager
	}
	if !sameCodexPlatformPackage(probe.ProtocolPackageName, layout.PlatformPackageName) ||
		(layout.PlatformPackagePresence != CodexPathMissing && layout.PlatformBinaryPresence != CodexPathMissing) {
		return assessment
	}
	if layout.PackageManager == "bun" || layout.PackageManager == "pnpm" {
		assessment.ReasonCode = "codex_platform_pkg_incomplete"
		assessment.RepairPlan = CodexRepairPlan{ReasonCode: "package_manager_owned_install"}
		return assessment
	}
	assessment.ReasonCode = "codex_platform_pkg_incomplete"
	assessment.RepairPlan = CodexRepairPlan{Allowed: true, ReasonCode: "codex_platform_pkg_incomplete"}
	return assessment
}

func sameCodexPlatformPackage(left, right string) bool {
	left = strings.ToLower(strings.TrimSpace(left))
	right = strings.ToLower(strings.TrimSpace(right))
	return left != "" && left == right
}

func codexProviderLastError(status ProviderStatus) *ProviderLastError {
	switch strings.TrimSpace(status.Availability.ReasonCode) {
	case "cli_not_found":
		return &ProviderLastError{Code: string(CodexErrCLIMissing), Message: "CLI binary not found"}
	case "codex_platform_pkg_incomplete":
		return &ProviderLastError{Code: string(CodexErrPlatformPkgIncomplete), Message: "Codex platform package is incomplete"}
	case "codex_version_too_old", "codex_version_unsupported":
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
	case CodexErrRuntimeBug:
		return "codex_runtime_bug"
	default:
		return "codex_runtime_error"
	}
}
