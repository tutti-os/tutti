package agentstatus

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

const (
	// agentNPMRegistryEnv pins a single npm registry for agent-adapter installs
	// (an enterprise proxy, or one specific mirror). When set, no fallback chain
	// is used — the operator's choice is trusted as-is.
	agentNPMRegistryEnv = "TUTTI_AGENT_NPM_REGISTRY"

	// officialNPMRegistry is the authoritative default source. Installers may
	// rank it behind a mirror when the user's current network makes a mirror
	// measurably faster.
	officialNPMRegistry = "https://registry.npmjs.org"

	// CN-available fallback mirrors, used when public npm is slow or blocked.
	// These mirrors were verified to host large platform optional-dependency
	// packages end-to-end. They serve identical tarballs, so npm integrity
	// verification is unaffected.
	huaweiNPMRegistry  = "https://repo.huaweicloud.com/repository/npm/" // Huawei Cloud
	tencentNPMRegistry = "https://mirrors.cloud.tencent.com/npm/"       // Tencent Cloud

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

	// agentNPMRegistryRankTimeout bounds the lightweight package metadata probe
	// used to order registries before a large npm install. It is intentionally
	// much shorter than an install attempt: a registry that cannot return metadata
	// quickly should not get the first shot at a 100MB+ optional platform binary.
	agentNPMRegistryRankTimeout = 5 * time.Second

	// Avoid reshuffling registries on tiny timing noise from goroutine scheduling,
	// DNS cache warmth, or localhost test transports. Meaningful network
	// differences are much larger than this.
	agentNPMRegistryRankMinDifference = 25 * time.Millisecond
)

// agentNPMRegistries returns the ordered list of npm registries to try for
// agent-adapter installs. Official is first (fastest and authoritative when
// reachable); the CN-available mirrors are fallbacks for slow/blocked public-npm
// access. An explicit TUTTI_AGENT_NPM_REGISTRY pins a single registry with no
// fallback.
func (s Service) agentNPMRegistries() []string {
	if override := strings.TrimSpace(s.lookupEnv(agentNPMRegistryEnv)); override != "" {
		return []string{override}
	}
	return []string{
		officialNPMRegistry,
		huaweiNPMRegistry,
		tencentNPMRegistry,
	}
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
	registries := s.agentNPMRegistries()
	if len(registries) <= 1 {
		return registries
	}
	if ctx == nil {
		ctx = context.Background()
	}

	type probeResult struct {
		index     int
		registry  string
		reachable bool
		duration  time.Duration
	}
	results := make(chan probeResult, len(registries))
	for index, registry := range registries {
		go func(index int, registry string) {
			startedAt := time.Now()
			probeCtx, cancel := context.WithTimeout(ctx, agentNPMRegistryRankTimeout)
			defer cancel()
			reachable := s.probeNPMRegistryPackage(probeCtx, registry, packageName)
			results <- probeResult{
				index:     index,
				registry:  registry,
				reachable: reachable,
				duration:  time.Since(startedAt),
			}
		}(index, registry)
	}

	probed := make([]probeResult, 0, len(registries))
	for range registries {
		probed = append(probed, <-results)
	}
	sort.SliceStable(probed, func(i, j int) bool {
		left := probed[i]
		right := probed[j]
		if left.reachable != right.reachable {
			return left.reachable
		}
		if left.reachable && right.reachable {
			diff := left.duration - right.duration
			if diff < 0 {
				diff = -diff
			}
			if diff > agentNPMRegistryRankMinDifference {
				return left.duration < right.duration
			}
		}
		return left.index < right.index
	})

	ranked := make([]string, 0, len(probed))
	displayRanked := make([]string, 0, len(probed))
	for _, result := range probed {
		ranked = append(ranked, result.registry)
		displayRanked = append(displayRanked, displayNPMRegistry(result.registry))
	}
	slog.Info(
		"agent npm registries ranked",
		"package", strings.TrimSpace(packageName),
		"registries", displayRanked,
	)
	return ranked
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
	registry = strings.TrimRight(strings.TrimSpace(registry), "/")
	packageName = strings.TrimSpace(packageName)
	if registry == "" || packageName == "" {
		return registry
	}
	escapedPackage := strings.ReplaceAll(packageName, "/", "%2f")
	return registry + "/" + escapedPackage
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
