package sessionreplay

import "testing"

func TestCodexProviderReplayDescriptorDeclaresCompleteAdapter(t *testing.T) {
	descriptor, ok := FindProviderReplayByTarget(" local:CODEX ")
	if !ok {
		t.Fatal("Codex replay descriptor is missing")
	}
	if descriptor.ProviderID != "codex" ||
		descriptor.Tape.Codec != ProviderTapeCodecJSONRPC ||
		descriptor.Tape.RequestMatcher != ProviderRequestMatcherJSONRPC ||
		descriptor.Tape.InputObserver != ProviderInputObserverACPJSON ||
		descriptor.Tape.ProjectionCodec != ProviderProjectionCodecJSONRPCPortable ||
		descriptor.Tape.AuditCodec != ProviderAuditCodecJSONRPCPortable ||
		!descriptor.SupportsFormat(
			ProcessCassetteSchemaVersion,
			ProcessCassetteProjectionVersion,
		) ||
		!descriptor.MethodCarriesCredentials("account/login/start") ||
		!descriptor.IsOptionalProbeMethod("thread/read") ||
		!descriptor.IsHomeEnvVar("codex_home") ||
		descriptor.PortableRuntime.SessionHomeDirectory != "codex-home" {
		t.Fatalf("Codex replay descriptor = %#v", descriptor)
	}
	if len(descriptor.Tape.GeneratedRequestFields) != 1 ||
		descriptor.Tape.GeneratedRequestFields[0].Method != "turn/start" {
		t.Fatalf("generated request projections = %#v", descriptor.Tape.GeneratedRequestFields)
	}
}

func TestClaudeCodeProviderReplayDescriptorDeclaresCompleteAdapter(t *testing.T) {
	descriptor, ok := FindProviderReplayByTarget(" local:CLAUDE-code ")
	if !ok {
		t.Fatal("Claude Code replay descriptor is missing")
	}
	if descriptor.ProviderID != "claude-code" ||
		descriptor.Tape.Codec != ProviderTapeCodecClaudeSidecarV7 ||
		descriptor.Tape.RequestMatcher != ProviderRequestMatcherClaudeSidecarV7 ||
		descriptor.Tape.InputObserver != ProviderInputObserverClaudeSidecarV7 ||
		descriptor.Tape.ProjectionCodec != ProviderProjectionCodecClaudeSidecarV7Portable ||
		descriptor.Tape.AuditCodec != ProviderAuditCodecClaudeSidecarV7Portable ||
		!descriptor.SupportsFormat(
			ProcessCassetteSchemaVersion,
			ProcessCassetteProjectionVersion,
		) ||
		!descriptor.Tape.ExcludeEnvironment ||
		!descriptor.IsGeneratedIdentityField("turnID") ||
		!descriptor.IsGeneratedIdentityField("operationId") ||
		!descriptor.IsGeneratedIdentityField("sourceGoalOperationId") ||
		!descriptor.IsMatchedIdentityField("providerSessionID") ||
		descriptor.IsGeneratedIdentityField("providerSessionID") ||
		!descriptor.IsHomeEnvVar("claude_config_dir") ||
		descriptor.PortableRuntime.SessionHomeDirectory != "claude-home" {
		t.Fatalf("Claude Code replay descriptor = %#v", descriptor)
	}
}

func TestProviderReplayRegistryRejectsUnregisteredProviders(t *testing.T) {
	if _, ok := FindProviderReplayByProvider("cursor"); ok {
		t.Fatal("Cursor must not be replay-eligible without an adapter")
	}
	if _, ok := ResolveProviderReplay("local:cursor", "codex"); ok {
		t.Fatal("mismatched target and Provider resolved to Codex")
	}
}

func TestProviderReplayRegistryReturnsClones(t *testing.T) {
	descriptor, ok := FindProviderReplayByProvider("codex")
	if !ok {
		t.Fatal("Codex replay descriptor is missing")
	}
	descriptor.Tape.CredentialMethods[0] = "changed"
	descriptor.PortableRuntime.HomeEnvVars[0] = "CHANGED_HOME"

	again, ok := FindProviderReplayByProvider("codex")
	if !ok || !again.MethodCarriesCredentials("account/login/start") ||
		!again.IsHomeEnvVar("CODEX_HOME") {
		t.Fatalf("registry descriptor was mutated: %#v", again)
	}
}
