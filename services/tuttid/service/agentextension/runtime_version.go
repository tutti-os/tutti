package agentextension

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"golang.org/x/mod/semver"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
)

const (
	discoveryVersionSourceCommand       = "command"
	discoveryVersionSourceACPInitialize = "acp-initialize"
)

var semverExtractPattern = regexp.MustCompile(`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`)

func discoveryVersionSource(candidate DiscoveryCandidate) string {
	source := strings.TrimSpace(candidate.Version.Source)
	if source == "" {
		return discoveryVersionSourceCommand
	}
	return source
}

func (m *Manager) runtimeVersionCache() *runtimeVersionCache {
	m.versionCacheOnce.Do(func() {
		m.runtimeVersions = newRuntimeVersionCache()
	})
	return m.runtimeVersions
}

func (m *Manager) runtimeVersionForCandidate(
	ctx context.Context,
	executable string,
	candidate DiscoveryCandidate,
	cwd string,
	env []string,
	identity *agentruntime.ExecutableIdentity,
) (string, error) {
	if discoveryVersionSource(candidate) == discoveryVersionSourceACPInitialize {
		cacheArgs := append([]string{"acp-initialize"}, candidate.LaunchArgs...)
		return m.runtimeVersionCache().load(executable, cacheArgs, candidate.Version.Constraint, func() (string, error) {
			return runtimeVersionFromACPInitialize(ctx, executable, candidate, cwd, env, identity, m.Transport, m.Host)
		})
	}
	if identity != nil || len(env) == 0 {
		return m.runtimeVersionWithIdentity(ctx, executable, candidate.Version.Args, candidate.Version.Constraint, identity)
	}
	return m.runtimeVersionWithEnv(ctx, executable, candidate.Version.Args, candidate.Version.Constraint, env)
}

func (m *Manager) runtimeVersionWithEnv(
	ctx context.Context,
	executable string,
	args []string,
	constraint string,
	env []string,
) (string, error) {
	return m.runtimeVersionCache().load(executable, args, constraint, func() (string, error) {
		return runtimeVersionWithEnv(ctx, executable, args, constraint, env)
	})
}

func (m *Manager) runtimeVersionWithIdentity(
	ctx context.Context,
	executable string,
	args []string,
	constraint string,
	identity *agentruntime.ExecutableIdentity,
) (string, error) {
	return m.runtimeVersionCache().load(executable, args, constraint, func() (string, error) {
		return runtimeVersionWithIdentity(ctx, executable, args, constraint, identity)
	})
}

func runtimeVersionForCandidate(
	ctx context.Context,
	executable string,
	candidate DiscoveryCandidate,
	cwd string,
	env []string,
	identity *agentruntime.ExecutableIdentity,
	transport agentruntime.ProcessTransport,
	host agentruntime.HostMetadata,
) (string, error) {
	if discoveryVersionSource(candidate) == discoveryVersionSourceACPInitialize {
		return runtimeVersionFromACPInitialize(ctx, executable, candidate, cwd, env, identity, transport, host)
	}
	if identity != nil || len(env) == 0 {
		return runtimeVersionWithIdentity(ctx, executable, candidate.Version.Args, candidate.Version.Constraint, identity)
	}
	return runtimeVersionWithEnv(ctx, executable, candidate.Version.Args, candidate.Version.Constraint, env)
}

func runtimeVersionFromACPInitialize(
	ctx context.Context,
	executable string,
	candidate DiscoveryCandidate,
	cwd string,
	env []string,
	identity *agentruntime.ExecutableIdentity,
	transport agentruntime.ProcessTransport,
	host agentruntime.HostMetadata,
) (string, error) {
	timeout := time.Duration(candidate.Probe.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	command := append([]string{executable}, candidate.LaunchArgs...)
	rawVersion, err := agentruntime.ProbeStandardACPInitializeVersion(
		ctx, command, env, cwd, identity, timeout, transport, host,
	)
	if err != nil {
		return "", err
	}
	return parseAndValidateRuntimeVersion(rawVersion, candidate.Version.Constraint)
}

func runtimeVersionWithEnv(ctx context.Context, executable string, args []string, constraint string, env []string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, runtimeVersionProbeTimeout)
	defer cancel()
	command := newAgentExtensionCommand(probeCtx, executable, args...)
	command.Env = env
	output, err := command.CombinedOutput()
	if err != nil {
		return "", runtimeVersionProbeError(ctx, probeCtx, err)
	}
	return parseAndValidateRuntimeVersion(string(output), constraint)
}

func runtimeVersionWithIdentity(
	ctx context.Context,
	executable string,
	args []string,
	constraint string,
	identity *agentruntime.ExecutableIdentity,
) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, runtimeVersionProbeTimeout)
	defer cancel()
	var output []byte
	var err error
	if identity != nil {
		output, err = agentruntime.RunVerifiedExecutable(probeCtx, executable, args, identity)
	} else {
		output, err = newAgentExtensionCommand(probeCtx, executable, args...).CombinedOutput()
	}
	if err != nil {
		return "", runtimeVersionProbeError(ctx, probeCtx, err)
	}
	return parseAndValidateRuntimeVersion(string(output), constraint)
}

func parseAndValidateRuntimeVersion(raw, constraint string) (string, error) {
	version := semverExtractPattern.FindString(raw)
	if !validSemver(version) || !matchesConstraint(version, constraint) {
		return "", errors.New("runtime version is incompatible")
	}
	return version, nil
}

func runtimeVersionProbeError(ctx, probeCtx context.Context, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return fmt.Errorf("runtime version probe aborted: %w", ctxErr)
	}
	if errors.Is(probeCtx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf(
			"runtime version probe timed out after %s: %w",
			runtimeVersionProbeTimeout,
			context.DeadlineExceeded,
		)
	}
	return err
}

func matchesConstraint(version, constraint string) bool {
	for _, part := range strings.Fields(constraint) {
		switch {
		case strings.HasPrefix(part, ">="):
			if semver.Compare("v"+version, "v"+strings.TrimPrefix(part, ">=")) < 0 {
				return false
			}
		case strings.HasPrefix(part, ">"):
			if semver.Compare("v"+version, "v"+strings.TrimPrefix(part, ">")) <= 0 {
				return false
			}
		case strings.HasPrefix(part, "<="):
			if semver.Compare("v"+version, "v"+strings.TrimPrefix(part, "<=")) > 0 {
				return false
			}
		case strings.HasPrefix(part, "<"):
			if semver.Compare("v"+version, "v"+strings.TrimPrefix(part, "<")) >= 0 {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func validSemver(value string) bool { return semver.IsValid("v" + value) }
