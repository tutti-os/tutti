package types

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

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

func TuttidStateOwnershipLockPath() string {
	return filepath.Join(
		DefaultStateDir(),
		generatedDefaults.State.RunDirName,
		generatedDefaults.State.PIDFileName+".lock",
	)
}

func DefaultStateDir() string {
	return ResolveDefaultsFromEnv().State.RootDir
}

func DefaultAgentRuntimeDir() (string, error) {
	homeDir, err := userHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".local", "share", "tutti", "agent-runtimes"), nil
}

func DefaultAgentExecutableDir() (string, error) {
	homeDir, err := userHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".local", "bin"), nil
}

func userHomeDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	homeDir = strings.TrimSpace(homeDir)
	if homeDir == "" {
		return "", errors.New("user home directory is unavailable")
	}
	return homeDir, nil
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
