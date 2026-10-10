package agentextension

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/managednpm"
)

// perRegistryNPMInstallTimeout bounds a single registry attempt so a blocked or
// stalled source fails over to the next one instead of consuming the whole
// install budget. Mirrors the provider installer's per-registry budget.
const perRegistryNPMInstallTimeout = 150 * time.Second

// isNPMRunner reports whether an extension runtime installs through an npm-style
// client, which is the only runner that resolves packages through a registry
// and therefore benefits from the mirror fallback.
func isNPMRunner(runner string) bool {
	switch runner {
	case "npm", "pnpm":
		return true
	default:
		return false
	}
}

// runNPMInstallWithRegistryFallback installs an npm-based extension runtime,
// trying the official registry and the CN-available mirrors in ranked order.
// Each attempt is bounded and, on failure, the half-written install tree is
// purged so the next attempt starts clean. The install command is unchanged
// across attempts; only npm_config_registry selects the source, so the plan's
// runner-identity contract is preserved.
func (s *SetupService) runNPMInstallWithRegistryFallback(
	ctx context.Context,
	runner InstallCommandRunner,
	command []string,
	scratch string,
	staging string,
	baseEnv []string,
	plan InstallPlan,
) error {
	registries := rankedNPMRegistries(ctx, s.npmRegistryHTTPClient(), plan.PackageName, plan.PackageVersion)
	var lastErr error
	for index, registry := range registries {
		attemptCtx, cancel := context.WithTimeout(ctx, perRegistryNPMInstallTimeout)
		env := withNPMRegistry(slices.Clone(baseEnv), registry)
		err := runner.Run(attemptCtx, command, scratch, env)
		cancel()
		if err == nil {
			return nil
		}
		lastErr = err
		// A cancelled or expired parent context means the whole install is being
		// torn down (user cancel or daemon shutdown); do not fail over to another
		// registry — return the interruption immediately. A per-registry timeout
		// leaves the parent context live, so genuine failover still proceeds.
		if ctx.Err() != nil {
			break
		}
		// A failed or interrupted npm install can leave a half-written
		// node_modules (notably a `.<pkg>-<hash>` staging dir) that makes the
		// next attempt fail with ENOTEMPTY against the dirty tree. Purge it so
		// the next registry — or a later retry — starts clean.
		purgeStagingNPMTree(staging)
		if index < len(registries)-1 {
			slog.Warn(
				"agent extension npm install failed on registry, trying next",
				"event", "tutti.agent_extension.npm_install.registry_failover",
				"agentKey", plan.AgentKey,
				"registry", managednpm.DisplayRegistryHost(registry),
				"error", err,
			)
		}
	}
	if lastErr == nil {
		lastErr = errors.New("no npm registry available")
	}
	return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, lastErr)
}

func (s *SetupService) npmRegistryHTTPClient() *http.Client {
	if s.Plans.Manager != nil {
		return s.Plans.Manager.Client
	}
	return nil
}

// rankedNPMRegistries orders the official registry and the CN mirrors by a
// lightweight metadata probe so a blocked or slow source is tried last. It
// always returns at least one registry so the install still attempts, and it
// honours the TUTTI_AGENT_NPM_REGISTRY override (a single pinned source).
// Without an HTTP client the probe is skipped and the default order is used —
// ranking is a best-effort optimisation, the fallback loop is the guarantee.
func rankedNPMRegistries(ctx context.Context, client *http.Client, packageName, version string) []string {
	registries := managednpm.DefaultRegistries(strings.TrimSpace(os.Getenv(managednpm.RegistryOverrideEnv)))
	if len(registries) <= 1 || client == nil {
		return registryURLs(registries)
	}
	ranked := managednpm.RankRegistries(
		ctx,
		managednpm.Descriptor{PackageName: packageName, RecommendedVersion: version},
		registries,
		runtime.GOOS,
		runtime.GOARCH,
		extensionNPMRegistryProber{client: client},
	)
	urls := make([]string, len(ranked))
	for index := range ranked {
		urls[index] = ranked[index].Registry.URL
	}
	return urls
}

func registryURLs(registries []managednpm.Registry) []string {
	urls := make([]string, len(registries))
	for index := range registries {
		urls[index] = registries[index].URL
	}
	return urls
}

// extensionNPMRegistryProber implements managednpm.RegistryProber with a bounded
// GET against the package-version metadata endpoint. The managednpm package
// stays transport-free; the host owns the HTTP client.
type extensionNPMRegistryProber struct {
	client *http.Client
}

func (p extensionNPMRegistryProber) ProbeRegistry(
	ctx context.Context,
	request managednpm.RegistryProbeRequest,
) managednpm.RegistryProbeResult {
	if p.client == nil {
		return managednpm.RegistryProbeResult{}
	}
	endpoint := managednpm.PackageEndpoint(request.Registry.URL, request.PackageName, request.Version)
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return managednpm.RegistryProbeResult{}
	}
	response, err := p.client.Do(httpRequest)
	if err != nil {
		return managednpm.RegistryProbeResult{}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return managednpm.RegistryProbeResult{}
	}
	return managednpm.RegistryProbeResult{Reachable: true, Complete: true}
}

// withNPMRegistry returns env with exactly one npm_config_registry entry,
// dropping any inherited value so the ranked source is authoritative.
func withNPMRegistry(env []string, registry string) []string {
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

// purgeStagingNPMTree removes the npm install tree under the staging root so a
// retry starts from a clean slate. Best-effort: a removal failure is logged and
// the next attempt is still allowed to run.
func purgeStagingNPMTree(staging string) {
	staging = strings.TrimSpace(staging)
	if staging == "" {
		return
	}
	nodeModules := filepath.Join(staging, "node_modules")
	if err := os.RemoveAll(nodeModules); err != nil {
		slog.Warn(
			"agent extension npm install tree purge failed",
			"event", "tutti.agent_extension.npm_install.tree_purge_failed",
			"path", nodeModules,
			"error", err,
		)
	}
}
