package host

func CanTransitionInstallation(from, to InstallationState) bool {
	allowed := map[InstallationState]map[InstallationState]bool{
		InstallationStateNotInstalled: {
			InstallationStateInstalling: true,
		},
		InstallationStateInstalling: {
			InstallationStateInstalled: true,
			InstallationStateFailed:    true,
		},
		InstallationStateInstalled: {
			InstallationStateUpdating:     true,
			InstallationStateUninstalling: true,
		},
		InstallationStateUpdating: {
			InstallationStateInstalled: true,
			InstallationStateFailed:    true,
		},
		InstallationStateUninstalling: {
			InstallationStateNotInstalled: true,
			InstallationStateFailed:       true,
		},
		InstallationStateFailed: {
			InstallationStateInstalling:   true,
			InstallationStateUpdating:     true,
			InstallationStateUninstalling: true,
		},
	}
	return allowed[from][to]
}

func CanTransitionAuthorization(from, to AuthorizationState) bool {
	allowed := map[AuthorizationState]map[AuthorizationState]bool{
		AuthorizationStateNotRequired: {},
		AuthorizationStateDisconnected: {
			AuthorizationStatePending: true,
		},
		AuthorizationStatePending: {
			AuthorizationStatePending:      true,
			AuthorizationStateConnected:    true,
			AuthorizationStateDisconnected: true,
			AuthorizationStateFailed:       true,
		},
		AuthorizationStateConnected: {
			AuthorizationStateDisconnected: true,
			AuthorizationStateExpired:      true,
			AuthorizationStateFailed:       true,
		},
		AuthorizationStateExpired: {
			AuthorizationStatePending:      true,
			AuthorizationStateDisconnected: true,
		},
		AuthorizationStateFailed: {
			AuthorizationStatePending:      true,
			AuthorizationStateDisconnected: true,
		},
	}
	return allowed[from][to]
}
