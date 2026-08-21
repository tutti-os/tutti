package preferences

import "testing"

func TestAgentSessionRecordingCapabilityFlagFailsClosed(t *testing.T) {
	if IsCapabilityFlagEnabled(nil, FeatureFlagAgentSessionRecording) {
		t.Fatal("absent agent Session Recording flag must resolve false")
	}
	if !IsCapabilityFlagEnabled(
		map[string]bool{FeatureFlagAgentSessionRecording: true},
		FeatureFlagAgentSessionRecording,
	) {
		t.Fatal("stored agent Session Recording true must win")
	}
	if IsCapabilityFlagEnabled(nil, "agent.unknown") {
		t.Fatal("unknown capability flag must resolve false")
	}
}

func TestMobileRemoteAccessCapabilityFlagIsPermanentlyDisabled(t *testing.T) {
	if IsCapabilityFlagEnabled(nil, FeatureFlagMobileRemoteAccess) {
		t.Fatal("absent mobile remote access flag must remain disabled")
	}
	if IsCapabilityFlagEnabled(
		map[string]bool{FeatureFlagMobileRemoteAccess: true},
		FeatureFlagMobileRemoteAccess,
	) {
		t.Fatal("stored mobile remote access true must be ignored")
	}
}
