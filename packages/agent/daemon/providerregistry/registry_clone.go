package providerregistry

func cloneDescriptor(value ProviderDescriptor) ProviderDescriptor {
	value.Identity.Aliases = append([]string(nil), value.Identity.Aliases...)
	value.Runtime.Command = append([]string(nil), value.Runtime.Command...)
	value.Runtime.Endpoint.BaseURLEnvVars = append([]string(nil), value.Runtime.Endpoint.BaseURLEnvVars...)
	value.Runtime.StandardACP.PermissionModes = append([]RuntimePermissionModeDescriptor(nil), value.Runtime.StandardACP.PermissionModes...)
	value.Runtime.StandardACP.SettingsEnvironment.JSONFields = append(
		[]RuntimeSettingsJSONFieldDescriptor(nil),
		value.Runtime.StandardACP.SettingsEnvironment.JSONFields...,
	)
	value.Status.BinaryNames = append([]string(nil), value.Status.BinaryNames...)
	value.Status.AdapterBinaryNames = append([]string(nil), value.Status.AdapterBinaryNames...)
	value.Status.AuthStatusCommand = append([]string(nil), value.Status.AuthStatusCommand...)
	value.Status.AuthMarkerPaths = append([]string(nil), value.Status.AuthMarkerPaths...)
	value.Status.APIEndpoints = append([]string(nil), value.Status.APIEndpoints...)
	value.Status.CustomConfigEnvVars = append([]string(nil), value.Status.CustomConfigEnvVars...)
	value.Status.CredentialEnvVars = append([]string(nil), value.Status.CredentialEnvVars...)
	value.Status.LoginArgs = append([]string(nil), value.Status.LoginArgs...)
	value.Status.Install.FailureReasonMarkers = cloneStringSliceMap(value.Status.Install.FailureReasonMarkers)
	value.Status.AuthWatch.Sources = cloneAuthWatchSources(value.Status.AuthWatch.Sources)
	value.ComposerProfile.ReasoningEffortValues = append([]string(nil), value.ComposerProfile.ReasoningEffortValues...)
	value.ComposerProfile.SpeedValues = append([]string(nil), value.ComposerProfile.SpeedValues...)
	value.ComposerProfile.Capabilities = append([]string(nil), value.ComposerProfile.Capabilities...)
	value.ComposerProfile.PermissionModes = append([]PermissionModeDescriptor(nil), value.ComposerProfile.PermissionModes...)
	value.ComposerProfile.SlashCommandPolicy.FallbackCommands = append([]string(nil), value.ComposerProfile.SlashCommandPolicy.FallbackCommands...)
	value.ComposerProfile.SlashCommandPolicy.CommandEffects = append([]SlashCommandEffectDescriptor(nil), value.ComposerProfile.SlashCommandPolicy.CommandEffects...)
	value.Events.Aliases = append([]string(nil), value.Events.Aliases...)
	value.ExternalImport.ScanDirectories = append([]string(nil), value.ExternalImport.ScanDirectories...)
	value.ExternalImport.SkipDirectoryPrefixes = append([]string(nil), value.ExternalImport.SkipDirectoryPrefixes...)
	return value
}

func cloneStringSliceMap(values map[string][]string) map[string][]string {
	if values == nil {
		return nil
	}
	result := make(map[string][]string, len(values))
	for key, entries := range values {
		result[key] = append([]string(nil), entries...)
	}
	return result
}

func cloneAuthWatchSources(values []AuthWatchSourceDescriptor) []AuthWatchSourceDescriptor {
	result := make([]AuthWatchSourceDescriptor, len(values))
	for index, source := range values {
		result[index] = source
		result[index].PathEnvVars = append([]string(nil), source.PathEnvVars...)
		result[index].RootCandidates = append([]AuthWatchRootCandidateDescriptor(nil), source.RootCandidates...)
		result[index].Paths = append([]string(nil), source.Paths...)
	}
	return result
}
