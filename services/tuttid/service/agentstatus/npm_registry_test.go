package agentstatus

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
)

func TestAgentNPMRegistriesDefaultsToOfficialFirstThenMirrors(t *testing.T) {
	service := Service{Environ: func() []string { return []string{"PATH=/usr/bin"} }}
	got := service.agentNPMRegistries()
	want := []string{
		"https://registry.npmjs.org",
		"https://registry.npmmirror.com",
		"https://repo.huaweicloud.com/repository/npm/",
		"https://mirrors.cloud.tencent.com/npm/",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("agentNPMRegistries() = %#v, want official-first chain %#v", got, want)
	}
}

func TestAgentNPMRegistriesOverridePinsSingleRegistry(t *testing.T) {
	service := Service{Environ: func() []string {
		return []string{"TUTTI_AGENT_NPM_REGISTRY=https://npm.internal.example/"}
	}}
	got := service.agentNPMRegistries()
	if !slices.Equal(got, []string{"https://npm.internal.example/"}) {
		t.Fatalf("agentNPMRegistries() = %#v, want single overridden registry (no fallback)", got)
	}
}

func TestRunExternalAgentRegistryNPMInstallerUsesOfficialWhenItSucceeds(t *testing.T) {
	runtimeRoot := fakeManagedRuntimeRoot(t)
	service := Service{
		ManagedRuntime: fakeManagedRuntimeResolver(t, runtimeRoot),
		Environ:        func() []string { return []string{"PATH=/usr/bin:/bin"} },
	}
	var registriesTried []string
	service.InstallCommand = func(_ context.Context, in InstallCommandInput) (InstallCommandResult, error) {
		registriesTried = append(registriesTried, registryFromEnv(in.Env))
		return InstallCommandResult{ExitCode: 0}, nil // official succeeds
	}

	if _, err := service.runExternalAgentRegistryNPMInstaller(context.Background(), "claude-code", npmInstallerSpec(t)); err != nil {
		t.Fatalf("runExternalAgentRegistryNPMInstaller() error = %v", err)
	}
	// Official succeeded → no mirror tax.
	if !slices.Equal(registriesTried, []string{"https://registry.npmjs.org"}) {
		t.Fatalf("registries tried = %#v, want only official", registriesTried)
	}
}

func TestRunExternalAgentRegistryNPMInstallerFallsBackToMirror(t *testing.T) {
	runtimeRoot := fakeManagedRuntimeRoot(t)
	service := Service{
		ManagedRuntime: fakeManagedRuntimeResolver(t, runtimeRoot),
		Environ:        func() []string { return []string{"PATH=/usr/bin:/bin"} },
	}
	var registriesTried []string
	service.InstallCommand = func(_ context.Context, in InstallCommandInput) (InstallCommandResult, error) {
		reg := registryFromEnv(in.Env)
		registriesTried = append(registriesTried, reg)
		if reg == "https://registry.npmjs.org" {
			return InstallCommandResult{ExitCode: 1, Stderr: "ETIMEDOUT"}, nil // official blocked
		}
		return InstallCommandResult{ExitCode: 0}, nil // first mirror succeeds
	}

	if _, err := service.runExternalAgentRegistryNPMInstaller(context.Background(), "claude-code", npmInstallerSpec(t)); err != nil {
		t.Fatalf("runExternalAgentRegistryNPMInstaller() error = %v", err)
	}
	want := []string{"https://registry.npmjs.org", "https://registry.npmmirror.com"}
	if !slices.Equal(registriesTried, want) {
		t.Fatalf("registries tried = %#v, want official then first mirror %#v", registriesTried, want)
	}
}

func TestRunExternalAgentRegistryNPMInstallerReplacesExistingRegistryEnv(t *testing.T) {
	runtimeRoot := fakeManagedRuntimeRoot(t)
	service := Service{
		ManagedRuntime: fakeManagedRuntimeResolver(t, runtimeRoot),
		Environ:        func() []string { return []string{"PATH=/usr/bin:/bin"} },
	}
	spec := npmInstallerSpec(t)
	spec.RegistryNPM.Env = map[string]string{
		"npm_config_registry": "https://registry.npmjs.org/",
	}
	var registriesTried []string
	service.InstallCommand = func(_ context.Context, in InstallCommandInput) (InstallCommandResult, error) {
		registriesTried = append(registriesTried, registryFromEnv(in.Env))
		return InstallCommandResult{ExitCode: 0}, nil
	}

	if _, err := service.runExternalAgentRegistryNPMInstaller(context.Background(), "claude-code", spec); err != nil {
		t.Fatalf("runExternalAgentRegistryNPMInstaller() error = %v", err)
	}
	if !slices.Equal(registriesTried, []string{"https://registry.npmjs.org"}) {
		t.Fatalf("registries tried = %#v, want normalized official registry", registriesTried)
	}
}

func TestResolveExternalRegistryNPMSpecExecEnvInjectsPrimaryRegistry(t *testing.T) {
	home := t.TempDir()
	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)

	service := probeTestService(home)
	service.ExternalAgentRegistry = registryStore
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)

	result, err := service.ResolveProviderCommand(context.Background(), "claude-code")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	if !slices.Contains(result.Command, "exec") || !slices.Contains(result.Command, prefixDir) {
		t.Fatalf("Command = %#v, want npm exec fallback under %q", result.Command, prefixDir)
	}
	if !slices.Contains(result.Env, "npm_config_registry=https://registry.npmjs.org") {
		t.Fatalf("adapter env = %#v, want primary (official) registry", result.Env)
	}
}

func TestWithAgentNPMCacheReplacesInheritedCacheEnv(t *testing.T) {
	env := []string{
		"PATH=/usr/bin",
		"npm_config_cache=/Users/someone/.npm",
	}
	got := withAgentNPMCache(env, "/tmp/tutti/npm-cache")

	var caches []string
	for _, kv := range got {
		if len(kv) > len("npm_config_cache=") && kv[:len("npm_config_cache=")] == "npm_config_cache=" {
			caches = append(caches, kv)
		}
	}
	if !slices.Equal(caches, []string{"npm_config_cache=/tmp/tutti/npm-cache"}) {
		t.Fatalf("npm_config_cache entries = %#v, want exactly the dedicated cache (inherited ~/.npm dropped)", caches)
	}
}

func TestRunExternalAgentRegistryNPMInstallerPinsDedicatedCache(t *testing.T) {
	runtimeRoot := fakeManagedRuntimeRoot(t)
	prefixDir := t.TempDir()
	service := Service{
		ManagedRuntime: fakeManagedRuntimeResolver(t, runtimeRoot),
		Environ:        func() []string { return []string{"PATH=/usr/bin:/bin"} },
	}
	spec := InstallerSpec{
		Kind: InstallerKindExternalAgentRegistryNPM,
		RegistryNPM: &ExternalAgentRegistryNPMInstallerSpec{
			Package:   "@agentclientprotocol/claude-agent-acp@0.50.0",
			PrefixDir: prefixDir,
		},
	}
	var gotCache string
	service.InstallCommand = func(_ context.Context, in InstallCommandInput) (InstallCommandResult, error) {
		gotCache = cacheFromEnv(in.Env)
		return InstallCommandResult{ExitCode: 0}, nil
	}

	if _, err := service.runExternalAgentRegistryNPMInstaller(context.Background(), "claude-code", spec); err != nil {
		t.Fatalf("runExternalAgentRegistryNPMInstaller() error = %v", err)
	}
	want := filepath.Join(prefixDir, agentNPMCacheDirName)
	if gotCache != want {
		t.Fatalf("npm_config_cache = %q, want dedicated cache %q (must not depend on global ~/.npm)", gotCache, want)
	}
}

func TestResolveExternalRegistryNPMSpecExecEnvPinsDedicatedCache(t *testing.T) {
	home := t.TempDir()
	registryStore, prefixDir := fakeClaudeExternalRegistry(t)
	runtimeRoot := fakeManagedRuntimeRoot(t)

	service := probeTestService(home)
	service.ExternalAgentRegistry = registryStore
	service.ManagedRuntime = fakeManagedRuntimeResolver(t, runtimeRoot)

	result, err := service.ResolveProviderCommand(context.Background(), "claude-code")
	if err != nil {
		t.Fatalf("ResolveProviderCommand() error = %v", err)
	}
	want := "npm_config_cache=" + filepath.Join(prefixDir, agentNPMCacheDirName)
	if !slices.Contains(result.Env, want) {
		t.Fatalf("adapter env = %#v, want dedicated npm cache %q", result.Env, want)
	}
}

func TestRunCodexCLILatestInstallerPinsDedicatedCache(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	writeExecutable(t, filepath.Join(binDir, npmBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, nodeBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	service := probeTestService(home)
	service.Environ = func() []string { return []string{"PATH=" + binDir} }
	service.IsExecutableFile = isTestExecutableUnderHome(home)

	var gotCache string
	service.InstallCommand = func(_ context.Context, in InstallCommandInput) (InstallCommandResult, error) {
		gotCache = cacheFromEnv(in.Env)
		return InstallCommandResult{ExitCode: 0}, nil
	}

	if _, err := service.runCodexCLILatestInstaller(context.Background(), InstallerSpec{
		Kind:     InstallerKindCodexCLILatest,
		CodexCLI: &CodexCLILatestInstallerSpec{},
	}, ""); err != nil {
		t.Fatalf("runCodexCLILatestInstaller() error = %v", err)
	}
	if gotCache == "" || filepath.Base(gotCache) != agentNPMCacheDirName {
		t.Fatalf("npm_config_cache = %q, want a dedicated cache dir (must not depend on global ~/.npm)", gotCache)
	}
}

// cacheFromEnv extracts the npm_config_cache value from a command env.
func cacheFromEnv(env []string) string {
	const prefix = "npm_config_cache="
	for _, kv := range env {
		if len(kv) > len(prefix) && kv[:len(prefix)] == prefix {
			return kv[len(prefix):]
		}
	}
	return ""
}

// registryFromEnv extracts the npm_config_registry value from a command env.
func registryFromEnv(env []string) string {
	const prefix = "npm_config_registry="
	for _, kv := range env {
		if len(kv) > len(prefix) && kv[:len(prefix)] == prefix {
			return kv[len(prefix):]
		}
	}
	return ""
}

func npmInstallerSpec(t *testing.T) InstallerSpec {
	t.Helper()
	return InstallerSpec{
		Kind: InstallerKindExternalAgentRegistryNPM,
		RegistryNPM: &ExternalAgentRegistryNPMInstallerSpec{
			Package:   "@agentclientprotocol/claude-agent-acp@0.50.0",
			PrefixDir: t.TempDir(),
		},
	}
}
