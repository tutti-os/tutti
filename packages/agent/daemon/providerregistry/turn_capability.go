package providerregistry

// SupportsNativePluginTurn reports whether a provider descriptor supports
// attaching a native plugin capability to the current Turn.
func SupportsNativePluginTurn(provider string) bool {
	descriptor, ok := Find(provider)
	return ok && descriptor.Runtime.TurnCapabilityStrategy == TurnCapabilityStrategyNativePlugin
}
