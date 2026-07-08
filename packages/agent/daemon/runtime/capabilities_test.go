package agentruntime

import (
	"context"
	"testing"
)

func TestCodexAppServerCapabilitiesUseSharedVocabulary(t *testing.T) {
	t.Parallel()
	capabilities := codexAppServerCapabilities(false)
	for _, want := range []string{
		CapabilityImageInput,
		CapabilitySkills,
		CapabilityCompact,
		CapabilityTokenUsage,
		CapabilityRateLimits,
		CapabilityInterrupt,
	} {
		if !containsString(capabilities, want) {
			t.Fatalf("codex capabilities = %v, missing %q", capabilities, want)
		}
	}
	if containsString(capabilities, CapabilityPlanMode) {
		t.Fatalf("codex must not advertise planMode without negotiated collaboration modes")
	}
	if !containsString(codexAppServerCapabilities(true), CapabilityPlanMode) {
		t.Fatalf("codex must advertise planMode when collaboration modes are negotiated")
	}
}

func TestStandardACPCapabilitiesByProvider(t *testing.T) {
	t.Parallel()
	claude := standardACPCapabilities(ProviderClaudeCode, true, acpLiveStateSnapshot{})
	for _, want := range []string{
		CapabilityImageInput, CapabilitySkills, CapabilityCompact,
		CapabilityTokenUsage, CapabilityRateLimits, CapabilityPlanMode, CapabilityInterrupt,
	} {
		if !containsString(claude, want) {
			t.Fatalf("claude capabilities = %v, missing %q", claude, want)
		}
	}

	opencode := standardACPCapabilities(ProviderOpenCode, true, acpLiveStateSnapshot{})
	for _, want := range []string{
		CapabilityImageInput, CapabilityPlanMode, CapabilityInterrupt,
	} {
		if !containsString(opencode, want) {
			t.Fatalf("opencode capabilities = %v, missing %q", opencode, want)
		}
	}

	cursor := standardACPCapabilities(ProviderCursor, true, acpLiveStateSnapshot{})
	if !containsString(cursor, CapabilityImageInput) || !containsString(cursor, CapabilityInterrupt) {
		t.Fatalf("cursor capabilities = %v, want imageInput+interrupt", cursor)
	}
	if !containsString(cursor, CapabilityPlanMode) {
		t.Fatalf("cursor capabilities missing planMode: %v", cursor)
	}
	if containsString(cursor, CapabilitySkills) {
		t.Fatalf("cursor capabilities too permissive: %v", cursor)
	}

	// 其他 ACP provider：保守派生——interrupt 恆有；imageInput 跟隨 promptImage；
	// compact 僅在 availableCommands 出現 compact 時亮起；無 skills/planMode。
	gemini := standardACPCapabilities(ProviderGemini, false, acpLiveStateSnapshot{})
	if containsString(gemini, CapabilityImageInput) ||
		containsString(gemini, CapabilityCompact) ||
		containsString(gemini, CapabilitySkills) ||
		containsString(gemini, CapabilityPlanMode) {
		t.Fatalf("gemini capabilities too permissive: %v", gemini)
	}
	if !containsString(gemini, CapabilityInterrupt) {
		t.Fatalf("gemini capabilities missing interrupt: %v", gemini)
	}

	withCompact := standardACPCapabilities(ProviderGemini, true, acpLiveStateSnapshot{
		availableCommands: []AgentSessionCommand{{Name: "compact"}},
	})
	if !containsString(withCompact, CapabilityCompact) || !containsString(withCompact, CapabilityImageInput) {
		t.Fatalf("derived capabilities = %v, want compact+imageInput", withCompact)
	}
}

func TestClaudeCodeSessionStateReportsCapabilities(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Claude Agent", "claude-session-1")
	adapter := NewClaudeCodeAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "claude-session-1"

	snapshot := adapter.SessionState(session)
	capabilities, _ := snapshot.RuntimeContext["capabilities"].([]string)
	if !containsString(capabilities, CapabilityPlanMode) || !containsString(capabilities, CapabilityInterrupt) {
		t.Fatalf("claude session capabilities = %v", capabilities)
	}
}
