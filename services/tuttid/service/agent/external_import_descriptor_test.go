package agent

import (
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func TestExternalImportAgentTargetIDUsesMigratedProviderDescriptor(t *testing.T) {
	descriptor, ok := providerregistry.Find(providerregistry.CodexProviderID)
	if !ok {
		t.Fatal("codex descriptor missing")
	}
	input := " CODEX "
	if got := externalImportAgentTargetID(input); got != descriptor.Target.ID {
		t.Fatalf("externalImportAgentTargetID(%q) = %q, want %q", input, got, descriptor.Target.ID)
	}
	if got := externalImportAgentTargetID("claude-code"); got != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("externalImportAgentTargetID(claude-code) = %q, want %q", got, agenttargetbiz.IDLocalClaudeCode)
	}
}

func TestExternalImportPoliciesAreDescriptorOwned(t *testing.T) {
	codex, ok := providerregistry.Find(providerregistry.CodexProviderID)
	if !ok {
		t.Fatal("codex descriptor missing")
	}
	if !codex.ExternalImport.Enabled || codex.ExternalImport.ParserKind != providerregistry.ExternalImportParserKindCodexJSONL || codex.ExternalImport.RootEnvVar != "CODEX_HOME" {
		t.Fatalf("codex external import = %#v", codex.ExternalImport)
	}
	claude, ok := providerregistry.Find(providerregistry.ClaudeCodeProviderID)
	if !ok {
		t.Fatal("claude descriptor missing")
	}
	if !claude.ExternalImport.Enabled || claude.ExternalImport.ParserKind != providerregistry.ExternalImportParserKindClaudeJSONL || claude.ExternalImport.UserTextCleanerKind != providerregistry.ExternalImportUserTextCleanerKindClaude {
		t.Fatalf("claude external import = %#v", claude.ExternalImport)
	}
	opencode, ok := providerregistry.Find(providerregistry.OpenCodeProviderID)
	if !ok {
		t.Fatal("opencode descriptor missing")
	}
	if opencode.ExternalImport.Enabled {
		t.Fatalf("opencode external import = %#v, want explicitly disabled", opencode.ExternalImport)
	}
}
