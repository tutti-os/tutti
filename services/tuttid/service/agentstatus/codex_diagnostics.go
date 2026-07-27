package agentstatus

import (
	"strings"
	"time"
)

// CodexCheckStatus is intentionally richer than a bool: layout evidence can
// be useful without being a runtime blocker.
type CodexCheckStatus string

const (
	CodexCheckPass          CodexCheckStatus = "pass"
	CodexCheckWarning       CodexCheckStatus = "warning"
	CodexCheckFail          CodexCheckStatus = "fail"
	CodexCheckSkipped       CodexCheckStatus = "skipped"
	CodexCheckNotApplicable CodexCheckStatus = "not_applicable"
	CodexCheckUnknown       CodexCheckStatus = "unknown"
)

type CodexDiagnosticCheck struct {
	ID         string
	Status     CodexCheckStatus
	DetailCode string
	Summary    string
	Blocking   bool
	CheckedAt  time.Time
	DurationMs int64
}

// CodexPathPresence deliberately distinguishes an absent file from an
// inaccessible or otherwise indeterminate path. Only Missing can corroborate
// a platform-package ENOENT for an automatic repair.
type CodexPathPresence string

const (
	CodexPathPresent       CodexPathPresence = "present"
	CodexPathMissing       CodexPathPresence = "missing"
	CodexPathUnknown       CodexPathPresence = "unknown"
	CodexPathInaccessible  CodexPathPresence = "inaccessible"
	CodexPathNotApplicable CodexPathPresence = "not_applicable"
)

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
	MissingPath         string
	CheckedAt           time.Time
}

type CodexRepairPlan struct {
	Allowed            bool
	Action             string
	ReasonCode         string
	SupportingEvidence []string
}

type CodexDiagnosis struct {
	RuntimeReady             bool
	ProviderReady            bool
	OverallStatus            string
	PrimaryDiagnosticCode    string
	SecondaryDiagnosticCodes []string
	RecommendedAction        string
}

type CodexDiagnosticSnapshot struct {
	Checks        []CodexDiagnosticCheck
	CommandProbe  CodexProbeEvidence
	ProtocolProbe CodexProbeEvidence
	PackageLayout CodexPackageLayoutEvidence
	Diagnosis     CodexDiagnosis
	RepairPlan    CodexRepairPlan
	EvidenceFresh bool
}

const (
	codexCheckCLIPresent        = "cli_present"
	codexCheckVersionFloor      = "version_floor"
	codexCheckAppServerCommand  = "app_server_command"
	codexCheckAppServerProtocol = "app_server_protocol"
	codexCheckNPMPackageLayout  = "npm_package_layout"
	codexCheckPlatformBinary    = "platform_binary"
	codexCheckNodeRuntime       = "node_runtime"
	codexCheckAuth              = "auth"
)

func evaluateCodexDiagnostics(snapshot CodexDiagnosticSnapshot) CodexDiagnosticSnapshot {
	check := func(id string) CodexDiagnosticCheck {
		for _, candidate := range snapshot.Checks {
			if candidate.ID == id {
				return candidate
			}
		}
		return CodexDiagnosticCheck{ID: id, Status: CodexCheckUnknown}
	}
	cli := check(codexCheckCLIPresent)
	version := check(codexCheckVersionFloor)
	command := check(codexCheckAppServerCommand)
	protocol := check(codexCheckAppServerProtocol)
	layout := check(codexCheckNPMPackageLayout)
	platformBinary := check(codexCheckPlatformBinary)
	auth := check(codexCheckAuth)

	diagnosis := CodexDiagnosis{OverallStatus: "unavailable", RecommendedAction: "retry"}
	diagnosis.RuntimeReady = cli.Status == CodexCheckPass && protocol.Status == CodexCheckPass
	platformDependencyMissing := codexPlatformDependencyMissing(snapshot)
	switch {
	case cli.Status != CodexCheckPass:
		diagnosis.PrimaryDiagnosticCode = "cli_not_found"
		diagnosis.RecommendedAction = "install"
	case version.Status == CodexCheckFail:
		diagnosis.PrimaryDiagnosticCode = "codex_version_unsupported"
		diagnosis.OverallStatus = "unsupported"
		diagnosis.RecommendedAction = "upgrade"
	case diagnosis.RuntimeReady && auth.Status != CodexCheckPass:
		diagnosis.PrimaryDiagnosticCode = "auth_required"
		if auth.DetailCode == "auth_unknown" {
			diagnosis.PrimaryDiagnosticCode = "auth_unknown"
		}
		diagnosis.OverallStatus = "auth_required"
		diagnosis.RecommendedAction = "login"
	case diagnosis.RuntimeReady:
		diagnosis.OverallStatus = "ready"
		diagnosis.RecommendedAction = "none"
	case (command.Status == CodexCheckFail && command.DetailCode == "app_server_unsupported") ||
		(protocol.Status == CodexCheckFail && protocol.DetailCode == "app_server_unsupported"):
		diagnosis.PrimaryDiagnosticCode = "app_server_unsupported"
		diagnosis.OverallStatus = "unsupported"
		diagnosis.RecommendedAction = "upgrade"
	case platformDependencyMissing:
		diagnosis.PrimaryDiagnosticCode = "codex_platform_pkg_incomplete"
		switch snapshot.PackageLayout.PackageManager {
		case "bun":
			diagnosis.RecommendedAction = "reinstall_with_bun"
		case "pnpm":
			diagnosis.RecommendedAction = "reinstall_with_pnpm"
		default:
			diagnosis.RecommendedAction = "repair"
		}
	case command.Status == CodexCheckFail && command.DetailCode == "acp_adapter_not_found":
		diagnosis.PrimaryDiagnosticCode = "acp_adapter_not_found"
		diagnosis.RecommendedAction = "install"
	case codexRuntimeBugEvidence(command, protocol, layout, platformBinary):
		diagnosis.PrimaryDiagnosticCode = "codex_runtime_bug"
		diagnosis.OverallStatus = "runtime_bug"
		diagnosis.RecommendedAction = "report_bug"
	case command.Status == CodexCheckFail:
		diagnosis.PrimaryDiagnosticCode = "acp_adapter_launch_failed"
	case protocol.Status == CodexCheckFail:
		diagnosis.PrimaryDiagnosticCode = "acp_adapter_launch_failed"
	default:
		diagnosis.PrimaryDiagnosticCode = "codex_runtime_error"
	}
	diagnosis.ProviderReady = diagnosis.RuntimeReady && version.Status != CodexCheckFail && auth.Status == CodexCheckPass
	snapshot.Diagnosis = diagnosis
	snapshot.RepairPlan = planCodexRepair(snapshot)
	return snapshot
}

func codexRuntimeBugEvidence(
	command CodexDiagnosticCheck,
	protocol CodexDiagnosticCheck,
	layout CodexDiagnosticCheck,
	platformBinary CodexDiagnosticCheck,
) bool {
	if command.Status != CodexCheckPass || protocol.Status != CodexCheckFail {
		return false
	}
	if protocol.DetailCode == "app_server_unsupported" || protocol.DetailCode == "platform_package_enoent" {
		return false
	}
	return platformBinary.Status == CodexCheckPass ||
		layout.Status == CodexCheckNotApplicable ||
		platformBinary.Status == CodexCheckNotApplicable
}

// planCodexRepair requires three corroborating conditions from runtime probing
// and an independent package-layout scan. A familiar stderr string alone is
// never authorization to overwrite a user installation.
func planCodexRepair(snapshot CodexDiagnosticSnapshot) CodexRepairPlan {
	if !codexPlatformDependencyMissing(snapshot) {
		return CodexRepairPlan{ReasonCode: "repair_evidence_insufficient"}
	}
	switch snapshot.PackageLayout.PackageManager {
	case "bun", "pnpm":
		return CodexRepairPlan{ReasonCode: "package_manager_owned_install"}
	default:
		return CodexRepairPlan{Allowed: true, Action: "install", ReasonCode: "codex_platform_pkg_incomplete", SupportingEvidence: []string{"app_server_probe_failed", "platform_package_enoent", "same_platform_package", "platform_binary_or_package_missing"}}
	}
}

func codexPlatformDependencyMissing(snapshot CodexDiagnosticSnapshot) bool {
	if snapshot.ProtocolProbe.ProtocolReady || !snapshot.EvidenceFresh {
		return false
	}
	failure, ok := codexFailedPlatformProbe(snapshot.CommandProbe, snapshot.ProtocolProbe)
	if !ok || failure.Category != "platform_package_enoent" {
		return false
	}
	if !sameCodexPlatformPackage(failure.PlatformPackageName, snapshot.PackageLayout.PlatformPackageName) {
		return false
	}
	return snapshot.PackageLayout.PlatformPackagePresence == CodexPathMissing ||
		snapshot.PackageLayout.PlatformBinaryPresence == CodexPathMissing
}

func codexFailedPlatformProbe(command, protocol CodexProbeEvidence) (CodexProbeEvidence, bool) {
	if protocol.Category == "platform_package_enoent" {
		if command.Category == "platform_package_enoent" && !sameCodexPlatformPackage(command.PlatformPackageName, protocol.PlatformPackageName) {
			return CodexProbeEvidence{}, false
		}
		return protocol, true
	}
	if command.Category == "platform_package_enoent" && !command.ProtocolReady {
		return command, true
	}
	return CodexProbeEvidence{}, false
}

func sameCodexPlatformPackage(left, right string) bool {
	left = strings.ToLower(strings.TrimSpace(left))
	right = strings.ToLower(strings.TrimSpace(right))
	return left != "" && left == right
}

func codexCheckToProviderCheck(check CodexDiagnosticCheck) ProviderCheck {
	passed := check.Status == CodexCheckPass || check.Status == CodexCheckWarning || check.Status == CodexCheckNotApplicable
	return ProviderCheck{Name: check.ID, Passed: passed, Detail: check.Summary}
}
