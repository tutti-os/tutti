package agentstatus

import (
	"context"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/tutti-os/tutti/packages/agent/daemon/runtimecmd"
)

// codexRuntimeCandidateSource records how a launcher entered a discovery
// snapshot. A logical installation can have more than one source when, for
// example, its launcher is both on PATH and returned by `bun pm bin -g`.
type codexRuntimeCandidateSource string

const (
	codexRuntimeCandidateSourcePath       codexRuntimeCandidateSource = "path"
	codexRuntimeCandidateSourceBunGlobal  codexRuntimeCandidateSource = "bun_global"
	codexRuntimeCandidateSourcePNPMGlobal codexRuntimeCandidateSource = "pnpm_global"
	codexRuntimeCandidateSourceNPMGlobal  codexRuntimeCandidateSource = "npm_global"
	codexRuntimeCandidateSourceHomebrew   codexRuntimeCandidateSource = "homebrew"
)

// codexRuntimeCandidate is discovery evidence only. Phase two adds version
// and app-server validation; phase one must not use these candidates to alter
// selection or launch behavior.
type codexRuntimeCandidate struct {
	LauncherPath string
	RealPath     string
	PackageRoot  string
	Sources      []codexRuntimeCandidateSource
}

// discoverCodexRuntimeCandidates enumerates every known Codex launcher source
// instead of stopping at the first PATH match. It intentionally does not
// perform version or app-server probes and is not connected to runtime
// selection yet.
func (s Service) discoverCodexRuntimeCandidates(ctx context.Context, spec ProviderSpec) []codexRuntimeCandidate {
	if !isCodexStatusSpec(spec) {
		return nil
	}
	resolver := s.commandResolver()
	env := resolver.Env(spec.AdapterEnv)
	result := codexRuntimeCandidateCollector{}
	result.addAll(resolveCodexLaunchers(resolver, env), codexRuntimeCandidateSourcePath)

	if path := resolver.ResolveBinary([]string{"codex"}, spec.AdapterEnv); path != "" {
		result.add(path, codexRuntimeCandidateSourcePath)
	}
	globalBins := s.discoverCodexGlobalBins(ctx, resolver, spec.AdapterEnv)
	for _, discovery := range []struct {
		binDir string
		source codexRuntimeCandidateSource
	}{
		{globalBins.bun, codexRuntimeCandidateSourceBunGlobal},
		{globalBins.pnpm, codexRuntimeCandidateSourcePNPMGlobal},
		{globalBins.npm, codexRuntimeCandidateSourceNPMGlobal},
		{globalBins.homebrew, codexRuntimeCandidateSourceHomebrew},
	} {
		if discovery.binDir != "" {
			result.addAll(resolveCodexLaunchersInDir(resolver, discovery.binDir), discovery.source)
		}
	}
	return result.candidates
}

type codexGlobalBins struct {
	bun      string
	pnpm     string
	npm      string
	homebrew string
}

// discoverCodexGlobalBins runs independent package-manager queries together so
// one slow manager does not hide later valid Codex installations. Candidates
// are still added in a stable source order after every query completes.
func (s Service) discoverCodexGlobalBins(
	ctx context.Context,
	resolver runtimecmd.Resolver,
	overrides []string,
) codexGlobalBins {
	var result codexGlobalBins
	var queries sync.WaitGroup
	queries.Add(4)
	go func() {
		defer queries.Done()
		result.bun = s.discoverBunGlobalBinDir(ctx, resolver, overrides)
	}()
	go func() {
		defer queries.Done()
		result.pnpm = s.discoverPnpmGlobalBinDir(ctx, resolver, overrides)
	}()
	go func() {
		defer queries.Done()
		result.npm = s.discoverNpmGlobalBinDir(ctx, resolver, overrides)
	}()
	go func() {
		defer queries.Done()
		result.homebrew = s.discoverHomebrewBinDir(ctx, resolver, overrides)
	}()
	queries.Wait()
	return result
}

func resolveCodexLaunchersInDir(resolver runtimecmd.Resolver, dir string) []string {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return nil
	}
	return resolveCodexLaunchers(resolver, []string{"PATH=" + dir})
}

func resolveCodexLaunchers(resolver runtimecmd.Resolver, env []string) []string {
	result := []string{}
	seen := map[string]struct{}{}
	for _, path := range resolver.ResolveAllNames(codexLauncherNames(), env) {
		key := codexRuntimeCandidateIdentity(path, path, "")
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, path)
	}
	return result
}

func codexLauncherNames() []string {
	if runtime.GOOS == "windows" {
		// Windows package managers expose executable shims with one of these
		// extensions. An extensionless file in an AppX resources directory is
		// the non-Windows companion shipped beside codex.exe and cannot be
		// launched by CreateProcess on Windows.
		return []string{"codex.exe", "codex.cmd", "codex.bat"}
	}
	return []string{"codex"}
}

func (s Service) discoverPnpmGlobalBinDir(ctx context.Context, resolver runtimecmd.Resolver, overrides []string) string {
	return s.runGlobalBinDirCommand(ctx, resolver, overrides, pnpmCommandNames(), []string{"bin", "-g"})
}

func (s Service) discoverNpmGlobalBinDir(ctx context.Context, resolver runtimecmd.Resolver, overrides []string) string {
	prefix := s.runGlobalBinDirCommand(ctx, resolver, overrides, npmCommandNames(), []string{"prefix", "-g"})
	if prefix == "" {
		return ""
	}
	if runtime.GOOS == "windows" {
		return prefix
	}
	return filepath.Join(prefix, "bin")
}

func (s Service) discoverHomebrewBinDir(ctx context.Context, resolver runtimecmd.Resolver, overrides []string) string {
	if runtime.GOOS == "windows" {
		return ""
	}
	prefix := s.runGlobalBinDirCommand(ctx, resolver, overrides, []string{"brew"}, []string{"--prefix"})
	if prefix == "" {
		return ""
	}
	return filepath.Join(prefix, "bin")
}

func (s Service) runGlobalBinDirCommand(
	ctx context.Context,
	resolver runtimecmd.Resolver,
	overrides []string,
	binaryNames []string,
	args []string,
) string {
	binaryPath := resolver.ResolveBinary(binaryNames, overrides)
	if binaryPath == "" {
		return ""
	}
	return s.GlobalBinDiscoveryCache.load(binaryPath, strings.Join(args, "\x00"), func() string {
		release, acquired := s.DetectionCommands.acquire(ctx)
		if !acquired {
			return ""
		}
		defer release()

		commandCtx, cancel := context.WithTimeout(baseContext(ctx), globalBinDiscoveryTimeout)
		defer cancel()
		command := exec.CommandContext(commandCtx, binaryPath, args...)
		command.Env = resolver.Env(overrides)
		output := &boundedCommandOutput{limit: bunGlobalBinOutputLimit}
		command.Stdout = output
		if err := command.Run(); err != nil {
			return ""
		}
		value := strings.TrimSpace(output.String())
		if !filepath.IsAbs(value) {
			return ""
		}
		return filepath.Clean(value)
	})
}

func pnpmCommandNames() []string {
	if runtime.GOOS == "windows" {
		return []string{"pnpm.cmd", "pnpm"}
	}
	return []string{"pnpm"}
}

func npmCommandNames() []string {
	if runtime.GOOS == "windows" {
		return []string{"npm.cmd", "npm"}
	}
	return []string{"npm"}
}

type codexRuntimeCandidateCollector struct {
	candidates []codexRuntimeCandidate
	byIdentity map[string]int
}

func (c *codexRuntimeCandidateCollector) addAll(paths []string, source codexRuntimeCandidateSource) {
	for _, path := range paths {
		c.add(path, source)
	}
}

func (c *codexRuntimeCandidateCollector) add(path string, source codexRuntimeCandidateSource) {
	path = strings.TrimSpace(path)
	if path == "" {
		return
	}
	path = materializeCodexWindowsAppsLauncher(path)
	realPath := resolvedCodexLauncherPath(path)
	packageRoot := codexPackageDirForBinary(realPath)
	identity := codexRuntimeCandidateIdentity(path, realPath, packageRoot)
	if c.byIdentity == nil {
		c.byIdentity = map[string]int{}
	}
	if index, found := c.byIdentity[identity]; found {
		candidate := &c.candidates[index]
		candidate.Sources = appendCodexRuntimeCandidateSource(candidate.Sources, source)
		return
	}
	c.byIdentity[identity] = len(c.candidates)
	c.candidates = append(c.candidates, codexRuntimeCandidate{
		LauncherPath: filepath.Clean(path),
		RealPath:     realPath,
		PackageRoot:  packageRoot,
		Sources:      []codexRuntimeCandidateSource{source},
	})
}

func resolvedCodexLauncherPath(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return filepath.Clean(resolved)
	}
	return filepath.Clean(path)
}

func codexRuntimeCandidateIdentity(launcherPath, realPath, packageRoot string) string {
	identity := firstNonBlank(packageRoot, realPath, launcherPath)
	if runtime.GOOS == "windows" {
		return strings.ToLower(filepath.Clean(identity))
	}
	return filepath.Clean(identity)
}

func appendCodexRuntimeCandidateSource(
	sources []codexRuntimeCandidateSource,
	source codexRuntimeCandidateSource,
) []codexRuntimeCandidateSource {
	for _, existing := range sources {
		if existing == source {
			return sources
		}
	}
	return append(sources, source)
}
