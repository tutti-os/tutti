package agentstatus

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/managednpm"
	managedruntime "github.com/tutti-os/tutti/services/tuttid/service/managedruntime"
)

func TestAgentNPMRegistriesDefaultsToOfficialFirstThenMirrors(t *testing.T) {
	service := Service{Environ: func() []string { return []string{"PATH=/usr/bin"} }}
	got := service.agentNPMRegistries()
	want := []string{
		"https://registry.npmjs.org",
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
		HTTPClient:     agentNPMRegistryProbeHTTPClient(nil),
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
		HTTPClient:     agentNPMRegistryProbeHTTPClient(nil),
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
	want := []string{"https://registry.npmjs.org", "https://repo.huaweicloud.com/repository/npm/"}
	if !slices.Equal(registriesTried, want) {
		t.Fatalf("registries tried = %#v, want official then first mirror %#v", registriesTried, want)
	}
}

func TestRunExternalAgentRegistryNPMInstallerPurgesDirtyTreeBeforeRetry(t *testing.T) {
	runtimeRoot := fakeManagedRuntimeRoot(t)
	service := Service{
		ManagedRuntime: fakeManagedRuntimeResolver(t, runtimeRoot),
		Environ:        func() []string { return []string{"PATH=/usr/bin:/bin"} },
		HTTPClient:     agentNPMRegistryProbeHTTPClient(nil),
	}
	spec := npmInstallerSpec(t)
	nodeModules := filepath.Join(spec.RegistryNPM.PrefixDir, "node_modules")
	staging := filepath.Join(nodeModules, "@anthropic-ai", ".claude-agent-sdk-darwin-arm64-DUAuoDRA")

	var registriesTried []string
	service.InstallCommand = func(_ context.Context, in InstallCommandInput) (InstallCommandResult, error) {
		registriesTried = append(registriesTried, registryFromEnv(in.Env))
		// A leftover staging directory from a prior interrupted attempt makes npm's
		// rename-to-staging fail with ENOTEMPTY, exactly as seen in the field. The
		// installer must purge node_modules between attempts so the retry starts clean.
		if _, err := os.Stat(staging); err == nil {
			return InstallCommandResult{ExitCode: 190, Stderr: "npm error code ENOTEMPTY"}, nil
		}
		// This attempt leaves the tree dirty, then fails like an interrupted install.
		if err := os.MkdirAll(staging, 0o755); err != nil {
			t.Fatalf("seed dirty staging dir: %v", err)
		}
		if len(registriesTried) == 1 {
			return InstallCommandResult{ExitCode: 190, Stderr: "npm error code ENOTEMPTY"}, nil
		}
		return InstallCommandResult{ExitCode: 0}, nil
	}

	result, err := service.runExternalAgentRegistryNPMInstaller(context.Background(), "claude-code", spec)
	if err != nil {
		t.Fatalf("runExternalAgentRegistryNPMInstaller() error = %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("install exit code = %d (stderr=%q), want a clean retry to succeed after purge", result.ExitCode, result.Stderr)
	}
	want := []string{"https://registry.npmjs.org", "https://repo.huaweicloud.com/repository/npm/"}
	if !slices.Equal(registriesTried, want) {
		t.Fatalf("registries tried = %#v, want official then mirror after purge %#v", registriesTried, want)
	}
}

func TestRunExternalAgentRegistryNPMInstallerReplacesExistingRegistryEnv(t *testing.T) {
	runtimeRoot := fakeManagedRuntimeRoot(t)
	service := Service{
		ManagedRuntime: fakeManagedRuntimeResolver(t, runtimeRoot),
		Environ:        func() []string { return []string{"PATH=/usr/bin:/bin"} },
		HTTPClient:     agentNPMRegistryProbeHTTPClient(nil),
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
		HTTPClient:     agentNPMRegistryProbeHTTPClient(nil),
	}
	spec := InstallerSpec{
		Kind: InstallerKindExternalAgentRegistryNPM,
		RegistryNPM: &ExternalAgentRegistryNPMInstallerSpec{
			Package:   "@agentclientprotocol/sample-agent-acp@0.50.0",
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

func TestRunCodexCLILatestInstallerPinsDedicatedCache(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	writeExecutable(t, filepath.Join(binDir, npmBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	writeExecutable(t, filepath.Join(binDir, nodeBinaryNameForTest()), "#!/bin/sh\nexit 0\n")
	service := probeTestService(home)
	service.HTTPClient = agentNPMRegistryProbeHTTPClient(nil)
	service.Environ = func() []string { return []string{"PATH=" + binDir} }
	service.IsExecutableFile = isTestExecutableUnderHome(home)

	var gotCache string
	service.InstallCommand = func(_ context.Context, in InstallCommandInput) (InstallCommandResult, error) {
		gotCache = cacheFromEnv(in.Env)
		return InstallCommandResult{ExitCode: 0}, nil
	}

	if _, err := service.runCodexCLILatestInstaller(context.Background(), "codex", InstallerSpec{
		Kind:     InstallerKindCodexCLILatest,
		CodexCLI: codexCLIInstallerSpec().CodexCLI,
	}, ""); err != nil {
		t.Fatalf("runCodexCLILatestInstaller() error = %v", err)
	}
	if gotCache == "" || filepath.Base(gotCache) != agentNPMCacheDirName {
		t.Fatalf("npm_config_cache = %q, want a dedicated cache dir (must not depend on global ~/.npm)", gotCache)
	}
}

func TestShellCommandNPMInstallerEnvPrefersManagedRuntime(t *testing.T) {
	runtimeRoot := fakeManagedRuntimeRoot(t)
	managedNodeBin := filepath.Join(runtimeRoot, "node", "bin")
	service := Service{
		ManagedRuntime: fakeManagedRuntimeResolver(t, runtimeRoot),
		Environ:        func() []string { return []string{"PATH=/usr/bin:/bin"} },
	}

	env := service.shellCommandInstallerEnv(context.Background(), InstallerSpec{
		Kind:         InstallerKindShellCommand,
		ShellCommand: "npm install -g openclaw",
	})
	path := managedruntime.EnvValue(env, "PATH")
	if !strings.HasPrefix(path, managedNodeBin+string(os.PathListSeparator)) {
		t.Fatalf("PATH = %q, want managed node bin first", path)
	}
}

func TestRankedAgentNPMRegistriesMovesUnreachableOfficialBehindReachableMirror(t *testing.T) {
	service := Service{
		Environ: func() []string { return []string{"PATH=/usr/bin"} },
		HTTPClient: agentNPMRegistryProbeHTTPClient(map[string]bool{
			"registry.npmjs.org": true,
		}),
	}

	got := service.rankedAgentNPMRegistries(context.Background(), "@openai/codex")
	if len(got) == 0 || got[0] != "https://repo.huaweicloud.com/repository/npm/" {
		t.Fatalf("rankedAgentNPMRegistries()[0] = %q, want first reachable mirror; full order=%#v", got[0], got)
	}
}

func TestRankedAgentNPMRegistriesMovesHTTPErrorBehindSuccessfulMirror(t *testing.T) {
	service := Service{
		Environ: func() []string { return []string{"PATH=/usr/bin"} },
		HTTPClient: &http.Client{Transport: networkRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			status := http.StatusOK
			if request.URL.Host == "registry.npmjs.org" {
				status = http.StatusNotFound
			}
			return &http.Response{
				StatusCode: status,
				Body:       io.NopCloser(strings.NewReader("ok")),
				Header:     make(http.Header),
			}, nil
		})},
	}

	got := service.rankedAgentNPMRegistries(context.Background(), "@openai/codex")
	if len(got) == 0 || got[0] != "https://repo.huaweicloud.com/repository/npm/" {
		t.Fatalf("rankedAgentNPMRegistries()[0] = %q, want first successful mirror; full order=%#v", got[0], got)
	}
}

func TestRankedManagedNPMRegistriesRejectsMirrorMissingPlatformPackage(t *testing.T) {
	npmOS, npmArch, ok := managednpm.NPMPlatform(runtime.GOOS, runtime.GOARCH)
	if !ok {
		t.Fatalf("NPMPlatform(%q, %q) unsupported", runtime.GOOS, runtime.GOARCH)
	}
	platformDependency := fmt.Sprintf("@tutti-os/tutti-agent-%s-%s", npmOS, npmArch)
	platformVersion := fmt.Sprintf("0.0.4-%s-%s", npmOS, npmArch)
	service := Service{
		Environ: func() []string { return []string{"PATH=/usr/bin"} },
		HTTPClient: &http.Client{Transport: networkRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			body := `{"version":"` + platformVersion + `"}`
			if !strings.Contains(request.URL.Path, platformVersion) {
				optional := ""
				if request.URL.Host != "registry.npmjs.org" {
					optional = fmt.Sprintf(`,"optionalDependencies":{"%s":"npm:@tutti-os/tutti-agent@%s"}`, platformDependency, platformVersion)
				}
				body = `{"version":"0.0.4"` + optional + `}`
			}
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
		})},
	}

	got := service.rankedManagedNPMRegistries(context.Background(), ManagedNPMPackageInstallerSpec{
		PackageName: "@tutti-os/tutti-agent", PackageVersion: "0.0.4", BinaryName: "tutti-agent", IncludeOptional: true,
	})
	if len(got) == 0 || got[0] != "https://repo.huaweicloud.com/repository/npm/" {
		t.Fatalf("rankedManagedNPMRegistries()[0] = %q, want complete mirror; full order=%#v", got[0], got)
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

func agentNPMRegistryProbeHTTPClient(unreachableHosts map[string]bool) *http.Client {
	return &http.Client{Transport: networkRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if unreachableHosts[request.URL.Host] {
			return nil, errors.New("network unreachable")
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader("ok")),
			Header:     make(http.Header),
		}, nil
	})}
}

func npmInstallerSpec(t *testing.T) InstallerSpec {
	t.Helper()
	return InstallerSpec{
		Kind: InstallerKindExternalAgentRegistryNPM,
		RegistryNPM: &ExternalAgentRegistryNPMInstallerSpec{
			Package:   "@agentclientprotocol/sample-agent-acp@0.50.0",
			PrefixDir: t.TempDir(),
		},
	}
}
