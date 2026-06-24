package agentstatus

import (
	"context"
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

	if _, err := service.runExternalAgentRegistryNPMInstaller(context.Background(), npmInstallerSpec(t)); err != nil {
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

	if _, err := service.runExternalAgentRegistryNPMInstaller(context.Background(), npmInstallerSpec(t)); err != nil {
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

	if _, err := service.runExternalAgentRegistryNPMInstaller(context.Background(), spec); err != nil {
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
