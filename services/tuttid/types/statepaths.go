package types

func TuttidDBPath() string {
	return ResolveDefaultsFromEnv().State.TuttidDBPath
}

func TuttidLogsDir() string {
	return ResolveDefaultsFromEnv().State.LogsDir
}

func TuttidLogPath() string {
	return ResolveDefaultsFromEnv().State.TuttidLogPath
}

func TuttidRunDir() string {
	return ResolveDefaultsFromEnv().State.RunDir
}

func TuttidListenerInfoPath() string {
	return ResolveDefaultsFromEnv().State.TuttidListenerInfoPath
}

func TuttidPIDPath() string {
	return ResolveDefaultsFromEnv().State.TuttidPIDPath
}

func DefaultStateDir() string {
	return ResolveDefaultsFromEnv().State.RootDir
}

func IsDevelopmentEnv() bool {
	return ResolveDefaultsFromEnv().Runtime.Env == "development"
}

func DesktopLoginCallbackURL() string {
	if IsDevelopmentEnv() {
		return "tutti-dev://login/callback"
	}
	return "tutti://login/callback"
}
