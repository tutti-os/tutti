package agentextension

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"
)

// PyPI package indexes for uv-runner extension runtimes, tried in order. The
// official index comes first; the CN-available mirrors follow so a network
// that cannot reach pypi.org (the field failure mode this exists for) still
// installs. Same vendors as the npm mirror chain in managednpm, so a network
// that admits one family admits the other.
const (
	officialPyPIIndexURL = "https://pypi.org/simple"
	huaweiPyPIIndexURL   = "https://repo.huaweicloud.com/repository/pypi/simple"
	tencentPyPIIndexURL  = "https://mirrors.cloud.tencent.com/pypi/simple"

	// uvIndexOverrideEnv pins a single package index, mirroring
	// TUTTI_AGENT_NPM_REGISTRY on the npm side.
	uvIndexOverrideEnv = "TUTTI_AGENT_PYPI_INDEX"
)

// uvPerIndexInstallTimeout bounds one index attempt so a blocked or stalled
// source fails over instead of consuming the whole 15-minute install budget.
// uv installs are heavier than npm ones (managed CPython plus the package
// graph), so the budget is wider than the npm installer's per-registry bound.
const uvPerIndexInstallTimeout = 5 * time.Minute

// defaultPyPIIndexes returns the package indexes to try in order. No
// reachability ranking: unlike the npm path there is no probing client on this
// path today, and the fallback loop — not ordering — is the guarantee.
func defaultPyPIIndexes() []string {
	if value := strings.TrimSpace(os.Getenv(uvIndexOverrideEnv)); value != "" {
		return []string{value}
	}
	return []string{officialPyPIIndexURL, huaweiPyPIIndexURL, tencentPyPIIndexURL}
}

// runUVInstallWithIndexFallback runs the uv install command against each
// package index in turn. Only UV_DEFAULT_INDEX varies across attempts — the
// command itself is unchanged, so the plan's runner-identity contract holds.
// uv tool installs are idempotent per attempt (no receipt is written on
// failure, and partial downloads live in the content-addressed cache), so a
// retry against the next index starts from a consistent state without
// touching the install root.
func (s *SetupService) runUVInstallWithIndexFallback(
	ctx context.Context,
	runner InstallCommandRunner,
	command []string,
	cwd string,
	baseEnv []string,
	plan InstallPlan,
) error {
	indexes := defaultPyPIIndexes()
	var lastErr error
	for position, index := range indexes {
		attemptCtx, cancel := context.WithTimeout(ctx, uvPerIndexInstallTimeout)
		env := withUVDefaultIndex(slices.Clone(baseEnv), index)
		err := runner.Run(attemptCtx, command, cwd, env)
		cancel()
		if err == nil {
			return nil
		}
		lastErr = err
		// A cancelled or expired parent context means the install is being torn
		// down (user cancel or daemon shutdown); surface the interruption instead
		// of failing over. A per-index timeout leaves the parent context live.
		if ctx.Err() != nil {
			break
		}
		if position < len(indexes)-1 {
			slog.Warn(
				"agent extension uv install failed on package index, trying next",
				"event", "tutti.agent_extension.uv_install.index_failover",
				"agentKey", plan.AgentKey,
				"index", displayPyPIIndexHost(index),
				"error", err,
			)
		}
	}
	if lastErr == nil {
		lastErr = errors.New("no package index available")
	}
	return fmt.Errorf("%w: %w", ErrRuntimeInstallFailed, lastErr)
}

// withUVDefaultIndex returns env with exactly one UV_DEFAULT_INDEX entry,
// dropping any inherited value so the selected index is authoritative.
// UV_NO_CONFIG=1 (set by uvInstallEnvironment) only suppresses configuration
// files; environment variables still apply.
func withUVDefaultIndex(env []string, index string) []string {
	const prefix = "UV_DEFAULT_INDEX="
	result := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if strings.HasPrefix(strings.ToUpper(kv), prefix) {
			continue
		}
		result = append(result, kv)
	}
	return append(result, prefix+index)
}

func displayPyPIIndexHost(index string) string {
	parsed, err := url.Parse(strings.TrimSpace(index))
	if err != nil || parsed.Host == "" {
		return index
	}
	return parsed.Host
}
