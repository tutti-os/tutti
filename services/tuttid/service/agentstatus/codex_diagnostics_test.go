package agentstatus

import (
	"testing"
	"time"
)

func TestCodexDiagnosticsRuntimeReadyTruthTable(t *testing.T) {
	for _, test := range []struct {
		name     string
		cli      CodexCheckStatus
		protocol CodexCheckStatus
		want     bool
	}{
		{"cli fail protocol fail", CodexCheckFail, CodexCheckFail, false},
		{"cli fail protocol pass", CodexCheckFail, CodexCheckPass, false},
		{"cli pass protocol fail", CodexCheckPass, CodexCheckFail, false},
		{"cli pass protocol skipped", CodexCheckPass, CodexCheckSkipped, false},
		{"cli pass protocol unknown", CodexCheckPass, CodexCheckUnknown, false},
		{"cli pass protocol pass", CodexCheckPass, CodexCheckPass, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot := evaluateCodexDiagnostics(CodexDiagnosticSnapshot{Checks: []CodexDiagnosticCheck{
				{ID: codexCheckCLIPresent, Status: test.cli},
				{ID: codexCheckAppServerProtocol, Status: test.protocol},
				{ID: codexCheckVersionFloor, Status: CodexCheckFail},
				{ID: codexCheckAuth, Status: CodexCheckFail},
				{ID: codexCheckNPMPackageLayout, Status: CodexCheckFail},
				{ID: codexCheckPlatformBinary, Status: CodexCheckFail},
				{ID: codexCheckNodeRuntime, Status: CodexCheckFail},
			}})
			if snapshot.Diagnosis.RuntimeReady != test.want {
				t.Fatalf("runtime ready = %v, want %v", snapshot.Diagnosis.RuntimeReady, test.want)
			}
		})
	}
}

func TestCodexDiagnosticsPositiveProbeCacheRestoresOnlyVerifiedRuntime(t *testing.T) {
	now := time.Now().UTC()
	snapshot := (Service{}).codexDiagnosticsForStatus(ProviderSpec{}, ProviderStatus{
		CLI:     CLIStatus{Installed: true},
		Adapter: AdapterStatus{Installed: true},
		Auth:    AuthInfo{Status: AuthAuthenticated},
	}, ProbeResult{}, false, true, now)
	if !snapshot.Diagnosis.RuntimeReady {
		t.Fatalf("cached positive probe did not restore runtime readiness: %#v", snapshot)
	}
	if snapshot.EvidenceFresh || snapshot.RepairPlan.Allowed {
		t.Fatalf("cache snapshot = %#v, want non-fresh and never repair-authorizing", snapshot)
	}
}

func TestCodexDiagnosticsProtocolSuccessSurvivesUnsupportedVersion(t *testing.T) {
	snapshot := evaluateCodexDiagnostics(CodexDiagnosticSnapshot{Checks: []CodexDiagnosticCheck{
		{ID: codexCheckCLIPresent, Status: CodexCheckPass},
		{ID: codexCheckVersionFloor, Status: CodexCheckFail},
		{ID: codexCheckAppServerProtocol, Status: CodexCheckPass},
		{ID: codexCheckAuth, Status: CodexCheckPass},
	}})
	if !snapshot.Diagnosis.RuntimeReady || snapshot.Diagnosis.ProviderReady {
		t.Fatalf("diagnosis = %#v, want runtime ready but provider unsupported", snapshot.Diagnosis)
	}
	if snapshot.Diagnosis.OverallStatus != "unsupported" || snapshot.Diagnosis.RecommendedAction != "upgrade" {
		t.Fatalf("diagnosis = %#v, want unsupported upgrade", snapshot.Diagnosis)
	}
}

func TestCodexDiagnosticsProtocolSuccessWithAuthRequiredIsNotRepairable(t *testing.T) {
	snapshot := evaluateCodexDiagnostics(CodexDiagnosticSnapshot{Checks: []CodexDiagnosticCheck{
		{ID: codexCheckCLIPresent, Status: CodexCheckPass},
		{ID: codexCheckVersionFloor, Status: CodexCheckPass},
		{ID: codexCheckAppServerProtocol, Status: CodexCheckPass},
		{ID: codexCheckAuth, Status: CodexCheckFail, Summary: "authentication required"},
	}})
	if !snapshot.Diagnosis.RuntimeReady || snapshot.Diagnosis.ProviderReady {
		t.Fatalf("diagnosis = %#v, want runtime ready and provider not ready", snapshot.Diagnosis)
	}
	if snapshot.Diagnosis.RecommendedAction != "login" || snapshot.RepairPlan.Allowed {
		t.Fatalf("diagnosis/repair = %#v/%#v, want login without repair", snapshot.Diagnosis, snapshot.RepairPlan)
	}
}

func TestCodexDiagnosticsUnsupportedAppServerProtocolRequiresUpgrade(t *testing.T) {
	snapshot := evaluateCodexDiagnostics(CodexDiagnosticSnapshot{Checks: []CodexDiagnosticCheck{
		{ID: codexCheckCLIPresent, Status: CodexCheckPass},
		{ID: codexCheckVersionFloor, Status: CodexCheckPass},
		{ID: codexCheckAppServerCommand, Status: CodexCheckPass},
		{ID: codexCheckAppServerProtocol, Status: CodexCheckFail, DetailCode: "app_server_unsupported"},
		{ID: codexCheckAuth, Status: CodexCheckPass},
	}})
	if snapshot.Diagnosis.OverallStatus != "unsupported" ||
		snapshot.Diagnosis.PrimaryDiagnosticCode != "app_server_unsupported" ||
		snapshot.Diagnosis.RecommendedAction != "upgrade" {
		t.Fatalf("diagnosis = %#v, want unsupported app-server upgrade", snapshot.Diagnosis)
	}
	if snapshot.RepairPlan.Allowed {
		t.Fatalf("repair = %#v, unsupported app-server must not authorize repair", snapshot.RepairPlan)
	}
}

func TestCodexDiagnosticsCompleteRuntimeProtocolFailureIsBug(t *testing.T) {
	snapshot := evaluateCodexDiagnostics(CodexDiagnosticSnapshot{Checks: []CodexDiagnosticCheck{
		{ID: codexCheckCLIPresent, Status: CodexCheckPass},
		{ID: codexCheckVersionFloor, Status: CodexCheckPass},
		{ID: codexCheckAppServerCommand, Status: CodexCheckPass},
		{ID: codexCheckAppServerProtocol, Status: CodexCheckFail, DetailCode: "protocol_failure"},
		{ID: codexCheckNPMPackageLayout, Status: CodexCheckPass},
		{ID: codexCheckPlatformBinary, Status: CodexCheckPass},
		{ID: codexCheckAuth, Status: CodexCheckPass},
	}})
	if snapshot.Diagnosis.OverallStatus != "runtime_bug" ||
		snapshot.Diagnosis.PrimaryDiagnosticCode != "codex_runtime_bug" ||
		snapshot.Diagnosis.RecommendedAction != "report_bug" {
		t.Fatalf("diagnosis = %#v, want complete runtime protocol failure reported as bug", snapshot.Diagnosis)
	}
	if snapshot.RepairPlan.Allowed {
		t.Fatalf("repair = %#v, runtime bug must not authorize reinstall", snapshot.RepairPlan)
	}
}

func TestCodexRepairPlannerRequiresAllThreeEvidence(t *testing.T) {
	const platformPackage = "@openai/codex-darwin-arm64"
	missing := CodexPackageLayoutEvidence{PlatformPackageName: platformPackage, PlatformBinaryPresence: CodexPathMissing}
	present := CodexPackageLayoutEvidence{PlatformPackageName: platformPackage, PlatformBinaryPresence: CodexPathPresent, PlatformBinaryExecutable: true}
	nonExecutable := CodexPackageLayoutEvidence{PlatformPackageName: platformPackage, PlatformBinaryPresence: CodexPathPresent, PlatformBinaryExecutable: false}
	for _, test := range []struct {
		name     string
		snapshot CodexDiagnosticSnapshot
		allowed  bool
	}{
		{
			name: "command failure and protocol skipped with matching missing package",
			snapshot: CodexDiagnosticSnapshot{
				CommandProbe:  CodexProbeEvidence{Category: "platform_package_enoent", PlatformPackageName: platformPackage},
				PackageLayout: missing,
				EvidenceFresh: true,
			},
			allowed: true,
		},
		{
			name:     "platform ENOENT but binary present",
			snapshot: CodexDiagnosticSnapshot{ProtocolProbe: CodexProbeEvidence{Category: "platform_package_enoent", PlatformPackageName: platformPackage}, PackageLayout: present, EvidenceFresh: true},
		},
		{
			name:     "platform ENOENT but binary is non executable",
			snapshot: CodexDiagnosticSnapshot{ProtocolProbe: CodexProbeEvidence{Category: "platform_package_enoent", PlatformPackageName: platformPackage}, PackageLayout: nonExecutable, EvidenceFresh: true},
		},
		{
			name:     "permission failure and non executable binary",
			snapshot: CodexDiagnosticSnapshot{ProtocolProbe: CodexProbeEvidence{Category: "spawn_failed", Message: "EACCES"}, PackageLayout: nonExecutable, EvidenceFresh: true},
		},
		{
			name:     "handshake timeout and missing layout",
			snapshot: CodexDiagnosticSnapshot{ProtocolProbe: CodexProbeEvidence{Category: "handshake_timeout"}, PackageLayout: missing, EvidenceFresh: true},
		},
		{
			name:     "ordinary ENOENT is not a platform package proof",
			snapshot: CodexDiagnosticSnapshot{ProtocolProbe: CodexProbeEvidence{Category: "spawn_failed", Message: "ENOENT"}, PackageLayout: missing, EvidenceFresh: true},
		},
		{
			name:     "verified protocol overrides a missing layout",
			snapshot: CodexDiagnosticSnapshot{ProtocolProbe: CodexProbeEvidence{ProtocolReady: true, Category: "platform_package_enoent", PlatformPackageName: platformPackage}, PackageLayout: missing, EvidenceFresh: true},
		},
		{
			name: "different platform package is not repairable",
			snapshot: CodexDiagnosticSnapshot{
				ProtocolProbe: CodexProbeEvidence{Category: "platform_package_enoent", PlatformPackageName: "@openai/codex-linux-x64"},
				PackageLayout: CodexPackageLayoutEvidence{PlatformPackageName: "@openai/codex-linux-arm64", PlatformBinaryPresence: CodexPathMissing},
				EvidenceFresh: true,
			},
		},
		{
			name: "stale evidence is not repairable",
			snapshot: CodexDiagnosticSnapshot{
				ProtocolProbe: CodexProbeEvidence{Category: "platform_package_enoent", PlatformPackageName: platformPackage},
				PackageLayout: missing,
			},
		},
		{
			name: "bun-owned missing package is diagnosed but not npm repairable",
			snapshot: CodexDiagnosticSnapshot{
				ProtocolProbe: CodexProbeEvidence{Category: "platform_package_enoent", PlatformPackageName: platformPackage},
				PackageLayout: CodexPackageLayoutEvidence{
					PackageManager:         "bun",
					PlatformPackageName:    platformPackage,
					PlatformBinaryPresence: CodexPathMissing,
				},
				EvidenceFresh: true,
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := planCodexRepair(test.snapshot).Allowed; got != test.allowed {
				t.Fatalf("repair allowed = %v, want %v; snapshot=%#v", got, test.allowed, test.snapshot)
			}
		})
	}
}
