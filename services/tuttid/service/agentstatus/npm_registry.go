package agentstatus

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/managednpm"
)

const (
	// agentNPMRegistryEnv pins a single npm registry for agent-adapter installs
	// (an enterprise proxy, or one specific mirror). When set, no fallback chain
	// is used — the operator's choice is trusted as-is.
	agentNPMRegistryEnv = managednpm.RegistryOverrideEnv

	// officialNPMRegistry is the authoritative default source. Installers may
	// rank it behind a mirror when the user's current network makes a mirror
	// measurably faster.
	officialNPMRegistry = managednpm.OfficialRegistryURL

	// CN-available fallback mirrors, used when public npm is slow or blocked.
	// These mirrors were verified to host large platform optional-dependency
	// packages end-to-end. They serve identical tarballs, so npm integrity
	// verification is unaffected.
	huaweiNPMRegistry  = managednpm.HuaweiRegistryURL  // Huawei Cloud
	tencentNPMRegistry = managednpm.TencentRegistryURL // Tencent Cloud

	// agentNPMCacheDirName is the dedicated npm cache directory agent installs use
	// instead of npm's global ~/.npm. It lives inside the install prefix so it is
	// always tutti-owned and writable by the daemon's user. See withAgentNPMCache.
	agentNPMCacheDirName = ".npm-cache"

	// perRegistryInstallTimeout bounds each registry attempt so a blocked
	// registry fails over to the next one instead of consuming the whole install
	// budget. It must clear a working-but-slow registry: a direct install of the
	// codex package is ~6-44s, but the same large platform binary pulled through a
	// (throttled) system proxy is ~76-100s+. 90s sat right on that edge and killed
	// otherwise-succeeding installs, so it is set comfortably above the proxied
	// case while staying below the overall install timeout.
	perRegistryInstallTimeout = 150 * time.Second
)

// agentNPMRegistries returns the ordered list of npm registries to try for
// agent-adapter installs. Official is first (fastest and authoritative when
// reachable); the CN-available mirrors are fallbacks for slow/blocked public-npm
// access. An explicit TUTTI_AGENT_NPM_REGISTRY pins a single registry with no
// fallback.
func (s Service) agentNPMRegistries() []string {
	registries := managednpm.DefaultRegistries(s.lookupEnv(agentNPMRegistryEnv))
	result := make([]string, len(registries))
	for index := range registries {
		result[index] = registries[index].URL
	}
	return result
}

// primaryAgentNPMRegistry is the first registry to try (the override, or
// official). Used where a single registry must be chosen up front (the npm exec
// adapter fallback) rather than retried through the chain.
func (s Service) primaryAgentNPMRegistry() string {
	return s.agentNPMRegistries()[0]
}

func (s Service) preferredAgentNPMRegistry(ctx context.Context, packageName string) string {
	registries := s.rankedAgentNPMRegistries(ctx, packageName)
	if len(registries) == 0 {
		return ""
	}
	return registries[0]
}

func (s Service) rankedAgentNPMRegistries(ctx context.Context, packageName string) []string {
	return s.rankAgentNPMRegistries(ctx, managednpm.Descriptor{PackageName: packageName})
}

func (s Service) rankedManagedNPMRegistries(ctx context.Context, spec ManagedNPMPackageInstallerSpec) []string {
	return s.rankAgentNPMRegistries(ctx, managednpm.Descriptor{
		PackageName:        spec.PackageName,
		BinaryName:         spec.BinaryName,
		RecommendedVersion: spec.PackageVersion,
		IncludeOptional:    spec.IncludeOptional,
	})
}

func (s Service) rankAgentNPMRegistries(ctx context.Context, descriptor managednpm.Descriptor) []string {
	registries := s.agentNPMRegistries()
	if len(registries) <= 1 {
		return registries
	}
	candidates := make([]managednpm.Registry, len(registries))
	for index := range registries {
		candidates[index] = managednpm.Registry{ID: displayNPMRegistry(registries[index]), URL: registries[index]}
	}
	probed := managednpm.RankRegistries(ctx, descriptor, candidates, runtime.GOOS, runtime.GOARCH, agentNPMRegistryProber{service: s})
	ranked := make([]string, len(probed))
	displayRanked := make([]string, len(probed))
	for index := range probed {
		ranked[index] = probed[index].Registry.URL
		displayRanked[index] = displayNPMRegistry(probed[index].Registry.URL)
	}
	slog.Info(
		"agent npm registries ranked",
		"package", strings.TrimSpace(descriptor.PackageName),
		"version", strings.TrimSpace(descriptor.RecommendedVersion),
		"registries", displayRanked,
	)
	return ranked
}

type agentNPMRegistryProber struct {
	service Service
}

func (p agentNPMRegistryProber) ProbeRegistry(ctx context.Context, request managednpm.RegistryProbeRequest) managednpm.RegistryProbeResult {
	if strings.TrimSpace(request.Version) != "" {
		return p.service.probeNPMRegistryPackageVersion(ctx, request)
	}
	reachable := p.service.probeNPMRegistryPackage(ctx, request.Registry.URL, request.PackageName)
	return managednpm.RegistryProbeResult{Reachable: reachable, Complete: reachable}
}

func (s Service) probeNPMRegistryPackageVersion(ctx context.Context, request managednpm.RegistryProbeRequest) managednpm.RegistryProbeResult {
	metadata, ok := s.readNPMRegistryPackageVersion(ctx, request.Registry.URL, request.PackageName, request.Version)
	if !ok {
		return managednpm.RegistryProbeResult{}
	}
	if !request.IncludeOptional {
		return managednpm.RegistryProbeResult{Reachable: true, Complete: true}
	}
	platformPackage, platformVersion, ok := managednpm.ResolveOptionalPlatformPackage(
		request.PackageName,
		metadata.OptionalDependencies,
		request.OperatingSystem,
		request.Architecture,
	)
	if !ok {
		return managednpm.RegistryProbeResult{Reachable: true}
	}
	_, platformReady := s.readNPMRegistryPackageVersion(ctx, request.Registry.URL, platformPackage, platformVersion)
	return managednpm.RegistryProbeResult{Reachable: true, Complete: platformReady}
}

type npmPackageVersionMetadata struct {
	Version              string            `json:"version"`
	OptionalDependencies map[string]string `json:"optionalDependencies"`
}

func (s Service) readNPMRegistryPackageVersion(ctx context.Context, registry string, packageName string, version string) (npmPackageVersionMetadata, bool) {
	endpoint := managednpm.PackageEndpoint(registry, packageName, version)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return npmPackageVersionMetadata{}, false
	}
	response, err := s.httpClient().Do(request)
	if err != nil {
		return npmPackageVersionMetadata{}, false
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return npmPackageVersionMetadata{}, false
	}
	var metadata npmPackageVersionMetadata
	decoder := json.NewDecoder(io.LimitReader(response.Body, 512*1024))
	if err := decoder.Decode(&metadata); err != nil || strings.TrimSpace(metadata.Version) != strings.TrimSpace(version) {
		return npmPackageVersionMetadata{}, false
	}
	return metadata, true
}

func (s Service) probeNPMRegistryPackage(ctx context.Context, registry string, packageName string) bool {
	endpoint := npmRegistryPackageEndpoint(registry, packageName)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false
	}
	response, err := s.httpClient().Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
	return response.StatusCode >= 200 && response.StatusCode < 300
}

func npmRegistryPackageEndpoint(registry string, packageName string) string {
	return managednpm.PackageEndpoint(registry, packageName, "")
}

// withAgentNPMRegistry returns env with exactly one npm_config_registry entry.
func withAgentNPMRegistry(env []string, registry string) []string {
	const prefix = "npm_config_registry="
	result := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if strings.HasPrefix(strings.ToLower(kv), prefix) {
			continue
		}
		result = append(result, kv)
	}
	return append(result, prefix+registry)
}

// withAgentNPMCache returns env with npm_config_cache pinned to cacheDir,
// dropping any inherited value.
//
// Agent installs must not rely on npm's global cache (~/.npm). On machines where
// a prior `sudo npm install` left root-owned files there, every user-mode
// `npm install` fails with "EACCES ... cache folder contains root-owned files"
// before it ever reaches a registry — so the install can never succeed, and
// retrying across mirrors is futile (the failure is local, not network). Pinning
// a dedicated tutti-owned cache sidesteps the broken global cache entirely.
func withAgentNPMCache(env []string, cacheDir string) []string {
	const prefix = "npm_config_cache="
	result := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if strings.HasPrefix(strings.ToLower(kv), prefix) {
			continue
		}
		result = append(result, kv)
	}
	return append(result, prefix+cacheDir)
}

// lookupEnv reads a single environment variable, honoring an injected Environ for
// testability and falling back to the process environment otherwise.
func (s Service) lookupEnv(key string) string {
	if s.Environ == nil {
		return os.Getenv(key)
	}
	prefix := key + "="
	for _, kv := range s.Environ() {
		if strings.HasPrefix(kv, prefix) {
			return kv[len(prefix):]
		}
	}
	return ""
}
