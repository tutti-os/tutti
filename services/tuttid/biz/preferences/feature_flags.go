package preferences

const (
	FeatureFlagAgentSessionRecording = "agent.sessionRecording"
	FeatureFlagMobileRemoteAccess    = "mobile.remoteAccessSettings"
)

var capabilityFlagDefaults = map[string]bool{
	FeatureFlagAgentSessionRecording: false,
	FeatureFlagMobileRemoteAccess:    false,
}

var permanentlyDisabledCapabilityFlags = map[string]struct{}{
	FeatureFlagMobileRemoteAccess: {},
}

// IsCapabilityFlagEnabled resolves daemon-enforced feature behavior. Permanently
// disabled capabilities stay off even when an old profile stores them as true.
func IsCapabilityFlagEnabled(flags map[string]bool, key string) bool {
	if _, disabled := permanentlyDisabledCapabilityFlags[key]; disabled {
		return false
	}
	if enabled, ok := flags[key]; ok {
		return enabled
	}
	return capabilityFlagDefaults[key]
}
