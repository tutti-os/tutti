package agentstatus

import "time"

func (s Service) codexDiagnosticsForStatus(
	spec ProviderSpec,
	status ProviderStatus,
	probe ProbeResult,
	probeRan bool,
	probeCacheHit bool,
	now time.Time,
) CodexDiagnosticSnapshot {
	layout := s.scanCodexPackageLayout(status.CLI.BinaryPath)
	if spec.resolvedCLIManager != "" {
		layout.PackageManager = spec.resolvedCLIManager
	}
	check := func(id string, state CodexCheckStatus, detail, summary string, blocking bool) CodexDiagnosticCheck {
		return CodexDiagnosticCheck{ID: id, Status: state, DetailCode: detail, Summary: summary, Blocking: blocking, CheckedAt: now}
	}
	cliState := CodexCheckFail
	if status.CLI.Installed {
		cliState = CodexCheckPass
	}
	versionState := CodexCheckPass
	if !cliVersionMeetsMinimumAllowUnknown(status.CLI.Version, status.CLI.MinVersion) {
		versionState = CodexCheckFail
	}
	commandState, protocolState := CodexCheckSkipped, CodexCheckSkipped
	commandDetail, protocolDetail := "not_probed", "not_probed"
	if probeCacheHit {
		// AdapterProbeCache is positive-only: markReady is reached only after a
		// completed protocol handshake. A cache hit therefore restores the exact
		// successful command/protocol state, never a failed or skipped probe.
		commandState, protocolState = CodexCheckPass, CodexCheckPass
		commandDetail, protocolDetail = "cached", "cached"
	} else if probeRan {
		if probe.CommandStarted {
			commandState, commandDetail = CodexCheckPass, "started"
		} else {
			commandState, commandDetail = CodexCheckFail, firstNonBlank(probe.CommandCategory, probe.ProtocolCategory)
		}
		if probe.ProtocolReady {
			protocolState, protocolDetail = CodexCheckPass, "initialized"
		} else if probe.CommandStarted {
			protocolState, protocolDetail = CodexCheckFail, firstNonBlank(probe.ProtocolCategory, probe.CommandCategory)
		} else {
			protocolState, protocolDetail = CodexCheckSkipped, "command_failed"
		}
	} else if !status.Adapter.Installed {
		commandState, commandDetail = CodexCheckFail, "acp_adapter_not_found"
	}
	layoutState := CodexCheckUnknown
	if layout.LayoutType == "homebrew_or_standalone" {
		layoutState = CodexCheckNotApplicable
	} else if layout.LayoutType != "unknown" {
		layoutState = CodexCheckPass
	}
	binaryState := CodexCheckUnknown
	if layout.LayoutType == "homebrew_or_standalone" {
		binaryState = CodexCheckNotApplicable
	} else if layout.PlatformPackageName != "" {
		switch layout.PlatformBinaryDetailCode {
		case "platform_binary_ready":
			binaryState = CodexCheckPass
		case "platform_binary_not_applicable":
			binaryState = CodexCheckNotApplicable
		case "platform_binary_presence_unknown", "platform_binary_inaccessible":
			binaryState = CodexCheckUnknown
		case "platform_binary_missing", "platform_package_missing", "platform_binary_not_executable":
			if protocolState == CodexCheckPass {
				// A verified runtime is authoritative. Structural absence remains a
				// non-blocking warning for diagnostics, never a contradiction.
				binaryState = CodexCheckWarning
			} else if layout.PlatformBinaryDetailCode == "platform_binary_not_executable" {
				binaryState = CodexCheckWarning
			} else {
				binaryState = CodexCheckFail
			}
		}
	}
	authState, authDetail := CodexCheckFail, "auth_required"
	switch status.Auth.Status {
	case AuthAuthenticated:
		authState, authDetail = CodexCheckPass, "auth"
	case AuthUnknown:
		authState, authDetail = CodexCheckUnknown, "auth_unknown"
	}
	node := s.codexNodeRuntimeCheck(spec)
	nodeState := CodexCheckFail
	if node.Passed {
		nodeState = CodexCheckPass
	}
	snapshot := CodexDiagnosticSnapshot{
		Checks: []CodexDiagnosticCheck{
			check(codexCheckCLIPresent, cliState, "cli_present", status.CLI.BinaryPath, true),
			check(codexCheckVersionFloor, versionState, "version_floor", status.CLI.Version, true),
			check(codexCheckAppServerCommand, commandState, commandDetail, probe.Message, true),
			check(codexCheckAppServerProtocol, protocolState, protocolDetail, probe.Message, true),
			check(codexCheckNPMPackageLayout, layoutState, layout.LayoutType, layout.PackageRoot, false),
			check(codexCheckPlatformBinary, binaryState, layout.PlatformBinaryDetailCode, layout.ExpectedPlatformBinaryPath, false),
			check(codexCheckNodeRuntime, nodeState, "node_runtime", node.Detail, false),
			check(codexCheckAuth, authState, authDetail, providerAvailabilityAuthDetailForStatus(status.Auth), true),
		},
		CommandProbe: CodexProbeEvidence{
			CommandStarted:      probe.CommandStarted || probeCacheHit,
			ProtocolReady:       probe.ProtocolReady || probeCacheHit,
			Category:            probe.CommandCategory,
			Message:             probe.Message,
			PlatformPackageName: probe.ProtocolPackageName,
			CheckedAt:           now,
		},
		ProtocolProbe: CodexProbeEvidence{
			CommandStarted:      probe.CommandStarted || probeCacheHit,
			ProtocolReady:       probe.ProtocolReady || probeCacheHit,
			Category:            probe.ProtocolCategory,
			Message:             probe.Message,
			PlatformPackageName: probe.ProtocolPackageName,
			CheckedAt:           now,
		},
		PackageLayout: layout,
		EvidenceFresh: probeRan && !probeCacheHit,
	}
	return evaluateCodexDiagnostics(snapshot)
}
