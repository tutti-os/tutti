package agentstatus

import (
	"os"
	"strings"
	"time"
)

const (
	// agentNPMRegistryEnv pins a single npm registry for agent-adapter installs
	// (an enterprise proxy, or one specific mirror). When set, no fallback chain
	// is used — the operator's choice is trusted as-is.
	agentNPMRegistryEnv = "TUTTI_AGENT_NPM_REGISTRY"

	// officialNPMRegistry is tried first: when reachable it is the fastest and
	// most authoritative source.
	officialNPMRegistry = "https://registry.npmjs.org"

	// CN-available fallback mirrors, used when public npm is slow or blocked.
	// All three were verified to host the full @agentclientprotocol/claude-agent-acp
	// dependency tree end-to-end, including the @anthropic-ai/claude-agent-sdk-*
	// platform binaries (the highest-risk packages). They serve identical tarballs,
	// so npm integrity verification is unaffected.
	npmmirrorRegistry  = "https://registry.npmmirror.com"               // Alibaba
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
		npmmirrorRegistry,
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
